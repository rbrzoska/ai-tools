export const meta = {
  name: 'factory-build',
  description: 'Factory: implement tickets in the run worktree, pass deterministic gates, then repeated judges, an adversary with probe tests, and refutation',
  whenToUse: 'Second half of a factory run, after the spec is approved. args: { run, tickets, size, reviewOnly?, judgeRuns?, maxFixRounds?, maxReviewRounds? }.',
  phases: [
    { title: 'Implement', detail: 'TDD per ticket, in dependency order' },
    { title: 'Gates', detail: 'deterministic script, tests run 3 times' },
    { title: 'Judge', detail: 'four judges, each run judgeRuns times' },
    { title: 'Attack', detail: 'adversary writes and runs probe tests' },
    { title: 'Merge', detail: 'merge repeated judge runs, mark unstable findings' },
    { title: 'Refute', detail: 'one refuter per finding or failing probe' },
  ],
}

const FACTORY = '~/.claude/skills/factory/bin/factory'
const AGENT_DIR = '~/.claude/skills/factory/agents'

// Model per stage (owner rule): light stages on haiku, the rest on sonnet, heavy work (size L or high
// risk) on opus. Fable only when the user asked for it: args.models = { <stage> | all: 'fable' | ... }.
const STAGE_TIER = {
  command: 'light', gates: 'light',
  grill: 'scaled', spec: 'scaled', plan: 'scaled', implement: 'scaled', judge: 'scaled',
  refute: 'scaled', attack: 'scaled', retro: 'scaled',
  merge: 'standard', match: 'standard', seed: 'standard', check: 'standard',
}
function modelFor(stage, scale = {}) {
  const override = args.models && (args.models[stage] || args.models.all)
  if (override) return override
  const tier = STAGE_TIER[stage] || 'standard'
  if (tier === 'light') return 'haiku'
  if (tier === 'scaled' && (scale.size === 'L' || scale.risk === 'high')) return 'opus'
  return 'sonnet'
}

const IMPLEMENTATION = {
  type: 'object',
  required: ['summary', 'commits', 'notDone'],
  properties: {
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
}

const GATES = {
  type: 'object',
  required: ['passed', 'failed'],
  properties: {
    passed: { type: 'boolean' },
    failed: { type: 'array', items: { type: 'string' } },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['gate', 'status'],
        properties: { gate: { type: 'string' }, status: { type: 'string' } },
      },
    },
    error: { type: 'string' },
  },
}

const FINDING = {
  type: 'object',
  required: ['severity', 'path', 'claim', 'evidence'],
  properties: {
    severity: { enum: ['blocking', 'minor'] },
    path: { type: 'string' },
    line: { type: 'number' },
    claim: { type: 'string' },
    evidence: { type: 'string' },
    rule: { type: 'string' },
  },
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict'],
        properties: {
          id: { type: 'string' },
          verdict: { enum: ['met', 'partial', 'missing'] },
          evidence: { type: 'string' },
        },
      },
    },
    findings: { type: 'array', items: FINDING },
    checkedInputs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['value', 'canBeAbsent', 'evidence'],
        properties: {
          value: { type: 'string' },
          source: { type: 'string' },
          canBeAbsent: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const MERGED = {
  type: 'object',
  required: ['clusters'],
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberIds', 'finding'],
        properties: { memberIds: { type: 'array', items: { type: 'string' } }, finding: FINDING },
      },
    },
  },
}

const PROBES = {
  type: 'object',
  required: ['probes'],
  properties: {
    probes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'criterion', 'input', 'expects', 'failed'],
        properties: {
          file: { type: 'string' },
          criterion: { type: 'string' },
          input: { type: 'string' },
          expects: { type: 'string' },
          failed: { type: 'boolean' },
        },
      },
    },
  },
}

const PROBE_RUN = {
  type: 'object',
  required: ['probes'],
  properties: {
    probes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'status'],
        properties: { file: { type: 'string' }, status: { type: 'string' }, output: { type: 'string' } },
      },
    },
    worktreeClean: { type: 'boolean' },
    leftover: { type: 'string' },
    error: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { enum: ['confirmed', 'refuted', 'uncertain'] },
    evidence: { type: 'string' },
  },
}

const JUDGES = [
  { key: 'spec', agentType: 'factory-judge-spec' },
  { key: 'robustness', agentType: 'factory-judge-robustness' },
  { key: 'tests', agentType: 'factory-judge-tests' },
  { key: 'standards', agentType: 'factory-judge-standards' },
]

const { run, tickets, size } = args
// A lighter review when the owner asks for it: args.judges = ['spec', 'robustness'], args.adversary = false.
const ACTIVE_JUDGES = Array.isArray(args.judges) && args.judges.length
  ? JUDGES.filter(judge => args.judges.includes(judge.key))
  : JUDGES
const adversaryOn = args.adversary !== false
const reviewOnly = Boolean(args.reviewOnly)
const judgeRuns = args.judgeRuns ?? 2
const maxFixRounds = args.maxFixRounds ?? 2
const maxReviewRounds = reviewOnly ? 1 : (args.maxReviewRounds ?? 2)
const scale = { size, risk: args.risk }
const implementerModel = modelFor('implement', scale)
const context = `Run directory: ${run.runDir}\nWorktree: ${run.worktree}\nBase commit: ${run.baseSha}`
const incidents = []

async function role(agentType, prompt, opts) {
  try {
    return await agent(prompt, { ...opts, agentType })
  } catch (error) {
    if (!String(error).includes('not found')) throw error
    incidents.push({ kind: 'agent-not-in-registry', agentType, label: opts.label })
    log(`${agentType} is not in the agent registry yet; running it from its definition file`)
    return agent(
      `Before anything else read ${AGENT_DIR}/${agentType}.md. Its body is your role; follow it exactly, including the tools it allows.\n\n${prompt}`,
      opts,
    )
  }
}

function runCommand(command, label, phaseTitle, schema) {
  return agent(
    `Run exactly this command with a long timeout and return its JSON output in the structured result, unchanged. Do not fix or retry anything; if it fails, put the error text in "error".\n\n${command}`,
    { model: modelFor('command'), effort: 'low', label, phase: phaseTitle, schema },
  )
}

function inDependencyOrder(list) {
  const done = new Set()
  const ordered = []
  let remaining = [...list]
  while (remaining.length) {
    const ready = remaining.filter(ticket => ticket.blockedBy.every(id => done.has(id)))
    if (!ready.length) throw new Error(`ticket dependency cycle: ${remaining.map(ticket => ticket.id).join(', ')}`)
    ready.forEach(ticket => { done.add(ticket.id); ordered.push(ticket) })
    remaining = remaining.filter(ticket => !done.has(ticket.id))
  }
  return ordered
}

function runGates(label) {
  return role('factory-gates', context, { model: modelFor('gates'), label: `gates:${label}`, phase: 'Gates', schema: GATES })
}

// A ticket may carry its own model from the planner (haiku | sonnet | opus); args.models still wins.
const TICKET_MODELS = new Set(['haiku', 'sonnet', 'opus'])
const ticketModel = Object.fromEntries((tickets || [])
  .filter(ticket => TICKET_MODELS.has(String(ticket.model || '').toLowerCase()))
  .map(ticket => [ticket.id, String(ticket.model).toLowerCase()]))

function implement(brief, label) {
  const override = args.models && (args.models.implement || args.models.all)
  return role('factory-implementer', `${context}\n\n${brief}`, {
    model: override || ticketModel[String(label).split(':')[0]] || implementerModel,
    label,
    phase: 'Implement',
    schema: IMPLEMENTATION,
  })
}

async function implementUntilGreen(brief, label) {
  const attempts = [await implement(brief, label)]
  let gates = await runGates(label)
  let fixRounds = 0
  while (gates && !gates.passed && fixRounds < maxFixRounds) {
    fixRounds++
    attempts.push(await implement(
      `Deterministic gates failed: ${gates.failed.join(', ')}. Read ${run.runDir}/gates.json for the output of each failed gate, fix exactly those failures and commit. A gate with status "flaky" passed in some runs and failed in others: find and remove the source of nondeterminism, never retry until green.`,
      `${label}:fix-${fixRounds}`,
    ))
    gates = await runGates(`${label}:fix-${fixRounds}`)
  }
  return { attempts, gates, fixRounds, green: Boolean(gates && gates.passed) }
}

async function judgeRepeated(judge, round) {
  const runs = await parallel(Array.from({ length: judgeRuns }, (_unused, runIndex) => () =>
    role(judge.agentType, `${context}\n\nIndependent review pass ${runIndex + 1} of ${judgeRuns}.`, {
      model: modelFor('judge', scale),
      label: `judge:${judge.key}:r${round}:p${runIndex + 1}`,
      phase: 'Judge',
      schema: FINDINGS,
    })))
  const completed = runs.filter(Boolean)
  if (!completed.length) return null
  const raw = completed.flatMap((result, runIndex) =>
    result.findings.map((finding, index) => ({ id: `p${runIndex + 1}-${index + 1}`, pass: runIndex + 1, ...finding })))

  let clusters = raw.map(finding => ({ memberIds: [finding.id], finding }))
  if (completed.length > 1 && raw.length) {
    const merged = await agent(
      `These findings come from ${completed.length} independent passes of the same "${judge.key}" reviewer over the same change. Group findings that describe the same problem at the same place; a finding joins at most one group. For each group return the member ids and one finding that states the problem best (keep the most severe severity among members). Every id must appear in exactly one group. Read no files.\n\n${JSON.stringify(raw, null, 2)}`,
      { model: modelFor('merge'), label: `merge:${judge.key}:r${round}`, phase: 'Merge', schema: MERGED },
    )
    if (merged) clusters = merged.clusters
  }
  const passOf = Object.fromEntries(raw.map(finding => [finding.id, finding.pass]))
  const findings = clusters.map((cluster, index) => {
    const passes = new Set(cluster.memberIds.map(id => passOf[id]).filter(Boolean))
    return {
      id: `${judge.key}-r${round}-${index + 1}`,
      judge: judge.key,
      ...cluster.finding,
      seenInPasses: passes.size,
      ofPasses: completed.length,
      stable: passes.size === completed.length,
    }
  })

  const criteriaRuns = completed.map(result => result.criteria || []).filter(list => list.length)
  const criterionIds = [...new Set(criteriaRuns.flatMap(list => list.map(item => item.id)))]
  const criteria = criterionIds.map(id => {
    const verdicts = criteriaRuns.map(list => (list.find(item => item.id === id) || {}).verdict || 'absent')
    return { id, verdicts, agree: new Set(verdicts).size === 1 }
  })
  const checkedInputs = completed.flatMap(result => result.checkedInputs || [])
  if (judge.key === 'robustness' && !checkedInputs.length) {
    incidents.push({ kind: 'robustness-without-checked-inputs', round })
  }
  return { judge: judge.key, passesCompleted: completed.length, findings, criteria, checkedInputs }
}

async function attack(round) {
  const written = await role('factory-adversary', context, {
    model: modelFor('attack', scale),
    label: `adversary:r${round}`,
    phase: 'Attack',
    schema: PROBES,
  })
  const ran = await runCommand(`${FACTORY} probe-run ${run.runDir}`, `probe-run:r${round}`, 'Attack', PROBE_RUN)
  if (!ran || ran.error) {
    incidents.push({ kind: 'probe-run-failed', error: ran && ran.error })
    return { written, ran, findings: [] }
  }
  if (ran.worktreeClean === false) incidents.push({ kind: 'probe-left-files', leftover: ran.leftover })
  const intent = Object.fromEntries(((written && written.probes) || []).map(probe => [probe.file.split('/').pop(), probe]))
  const findings = ran.probes
    .filter(probe => probe.status === 'fail' || probe.status === 'flaky')
    .map((probe, index) => {
      const name = probe.file.split('/').pop()
      const meant = intent[name] || {}
      return {
        id: `adversary-r${round}-${index + 1}`,
        judge: 'adversary',
        severity: probe.status === 'fail' ? 'blocking' : 'minor',
        path: `${run.runDir}/probes/${name}`,
        claim: `${meant.criterion || 'probe'}: with ${meant.input || 'the probe input'}, expected ${meant.expects || 'the probed behaviour'}, but the probe ${probe.status === 'fail' ? 'fails' : 'is flaky'}`,
        evidence: (probe.output || '').slice(-1500),
        seenInPasses: 1,
        ofPasses: 1,
        stable: probe.status === 'fail',
      }
    })
  return { written, ran, findings }
}

const built = []
if (!reviewOnly) {
  for (const ticket of inDependencyOrder(tickets)) {
    const result = await implementUntilGreen(
      `Ticket ${ticket.id}: ${ticket.title}\nAcceptance criteria: ${ticket.acceptanceCriteriaIds.join(', ')}\n\n${ticket.brief}`,
      ticket.id,
    )
    built.push({ ticket: ticket.id, ...result })
    if (!result.green) {
      log(`ticket ${ticket.id} did not pass gates after ${result.fixRounds} fix round(s); stopping`)
      return { status: 'gates-failed', built, reviewRounds: [], incidents }
    }
  }
} else {
  const gates = await runGates('review-only')
  built.push({ ticket: 'review-only', gates, fixRounds: 0, green: Boolean(gates && gates.passed) })
  if (!gates || !gates.passed) return { status: 'gates-failed', built, reviewRounds: [], incidents }
}

const reviewRounds = []
let openBlocking = []
for (let round = 1; round <= maxReviewRounds; round++) {
  const [judged, attacked] = await Promise.all([
    parallel(ACTIVE_JUDGES.map(judge => () => judgeRepeated(judge, round))),
    adversaryOn ? attack(round) : Promise.resolve({ written: null, ran: null, findings: [] }),
  ])
  const missingJudges = ACTIVE_JUDGES.filter((_judge, index) => !judged[index]).map(judge => judge.key)
  const findings = [...judged.filter(Boolean).flatMap(result => result.findings), ...attacked.findings]

  const checked = (await pipeline(findings, finding =>
    role('factory-refuter', `${context}\n\nFinding to refute:\n${JSON.stringify(finding, null, 2)}`, {
      model: modelFor('refute', scale),
      label: `refute:${finding.id}`,
      phase: 'Refute',
      schema: VERDICT,
    }).then(verdict => ({ ...finding, verdict: verdict ? verdict.verdict : 'uncertain', refuterEvidence: verdict ? verdict.evidence : 'refuter did not return' })))).filter(Boolean)

  const blocking = checked.filter(finding => finding.verdict === 'confirmed' && finding.severity === 'blocking')
  const specJudge = judged.find(result => result && result.judge === 'spec')
  const criteria = specJudge ? specJudge.criteria : []
  reviewRounds.push({
    round,
    missingJudges,
    criteria,
    criteriaDisagreements: criteria.filter(item => !item.agree).map(item => item.id),
    checkedInputs: (judged.find(result => result && result.judge === 'robustness') || {}).checkedInputs || [],
    unstableFindings: checked.filter(finding => !finding.stable).length,
    probes: attacked.ran ? attacked.ran.probes.map(({ file, status }) => ({ file, status })) : [],
    findings: checked,
  })
  openBlocking = blocking
  if (missingJudges.length) {
    log(`round ${round}: judge(s) did not return: ${missingJudges.join(', ')}`)
    return { status: 'judges-incomplete', built, reviewRounds, openBlocking, incidents }
  }
  if (!blocking.length || round === maxReviewRounds) break

  const fix = await implementUntilGreen(
    `Independent review confirmed these blocking findings. Fix exactly these and commit:\n${JSON.stringify(blocking.map(({ id, path, line, claim, evidence, rule }) => ({ id, path, line, claim, evidence, rule })), null, 2)}`,
    `review-fix-${round}`,
  )
  built.push({ ticket: `review-fix-${round}`, ...fix })
  if (!fix.green) return { status: 'gates-failed', built, reviewRounds, openBlocking, incidents }
}

return {
  status: openBlocking.length ? 'review-open' : 'passed',
  built,
  reviewRounds,
  openBlocking,
  incidents,
}
