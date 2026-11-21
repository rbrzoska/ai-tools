export const meta = {
  name: 'factory-calibrate',
  description: 'Factory: run the judges on historical PRs as the human reviewers saw them and measure how many human findings they reproduce',
  whenToUse: 'After changing a judge or refuter prompt. args: { prs: number[], repo?: path } - PR numbers from the repository's control set (see `factory calibrate-init`).',
  phases: [
    { title: 'Prepare', detail: 'worktree at the reviewed commit' },
    { title: 'Judge', detail: 'spec and standards judges' },
    { title: 'Refute', detail: 'one refuter per finding' },
    { title: 'Match', detail: 'compare with the human review' },
  ],
}

const FACTORY = '~/.claude/skills/factory/bin/factory'
const REPO = args.repo ? ` --repo ${args.repo}` : ''

const INIT = {
  type: 'object',
  required: ['worktree', 'viewDir', 'baseSha'],
  properties: {
    worktree: { type: 'string' },
    viewDir: { type: 'string' },
    baseSha: { type: 'string' },
    controlSet: { type: 'string' },
    error: { type: 'string' },
  },
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'path', 'claim', 'evidence'],
        properties: {
          severity: { enum: ['blocking', 'minor'] },
          path: { type: 'string' },
          line: { type: 'number' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
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

const MATCH = {
  type: 'object',
  required: ['humanFindings'],
  properties: {
    humanFindings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'summary', 'matchedFindingIds'],
        properties: {
          index: { type: 'number' },
          summary: { type: 'string' },
          matchedFindingIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const JUDGES = [
  { key: 'spec', agentType: 'factory-judge-spec' },
  { key: 'robustness', agentType: 'factory-judge-robustness' },
  { key: 'tests', agentType: 'factory-judge-tests' },
  { key: 'standards', agentType: 'factory-judge-standards' },
]

const AGENT_DIR = '~/.claude/skills/factory/agents'
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
    `Run exactly this command and return its JSON output in the structured result, unchanged. Do not fix or retry anything; if it fails, put the error text in "error".\n\n${command}`,
    { model: 'haiku', effort: 'low', label, phase: phaseTitle, schema },
  )
}

async function calibrate(pr) {
  const init = await runCommand(`${FACTORY} calibrate-init ${pr}${REPO}`, `init:${pr}`, 'Prepare', INIT)
  if (!init || init.error) return { pr, status: 'failed', stage: 'init', error: init && init.error }
  const context = `Run directory: ${init.viewDir}\nWorktree: ${init.worktree}\nBase commit: ${init.baseSha}`

  const judged = await parallel(JUDGES.map(judge => () =>
    role(judge.agentType, context, { model: 'opus', label: `judge:${judge.key}:${pr}`, phase: 'Judge', schema: FINDINGS })
      .then(result => result && { judge: judge.key, ...result })))
  const missingJudges = JUDGES.filter((_judge, index) => !judged[index]).map(judge => judge.key)
  if (missingJudges.length) {
    await runCommand(`${FACTORY} drop-worktree ${init.worktree}`, `cleanup:${pr}`, 'Judge', {
      type: 'object',
      properties: { dropped: { type: 'string' }, error: { type: 'string' } },
    })
    return { pr, status: 'judges-incomplete', missingJudges }
  }
  const raw = judged.filter(Boolean).flatMap(result =>
    result.findings.map((finding, index) => ({ id: `${result.judge}-${index + 1}`, judge: result.judge, ...finding })))

  const findings = (await pipeline(raw, finding =>
    role('factory-refuter', `${context}\n\nFinding to refute:\n${JSON.stringify(finding, null, 2)}`, { model: 'opus',
      label: `refute:${pr}:${finding.id}`,
      phase: 'Refute',
      schema: VERDICT,
    }).then(verdict => ({ ...finding, verdict: verdict ? verdict.verdict : 'uncertain' })))).filter(Boolean)

  const matched = await agent(
    `Read the entry with "pr": ${pr} in ${init.controlSet} and take its "reviewFindings" (what human reviewers flagged), numbered from 0 in file order.\n\nAutomated findings on the same code:\n${JSON.stringify(findings.map(({ id, path, line, claim, evidence }) => ({ id, path, line, claim, evidence })), null, 2)}\n\nFor each human finding return its index, its summary, and the ids of automated findings that describe that same problem: the same root issue at the same place. Same file or same topic with a different problem is not a match. Each automated finding may match at most one human finding; when it fits several, give it to the closest one. Return an empty list when nothing matches. Read no other files.`,
    { model: 'sonnet', label: `match:${pr}`, phase: 'Match', schema: MATCH },
  )

  await runCommand(`${FACTORY} drop-worktree ${init.worktree}`, `cleanup:${pr}`, 'Match', {
    type: 'object',
    properties: { dropped: { type: 'string' }, error: { type: 'string' } },
  })
  if (!matched) return { pr, status: 'failed', stage: 'match', missingJudges }

  const verdictOf = Object.fromEntries(findings.map(finding => [finding.id, finding.verdict]))
  const human = matched.humanFindings.map(item => ({
    ...item,
    raised: item.matchedFindingIds.length > 0,
    survivedRefuter: item.matchedFindingIds.some(id => verdictOf[id] !== 'refuted'),
  }))
  const matchedIds = new Set(human.flatMap(item => item.matchedFindingIds))
  return {
    pr,
    status: 'measured',
    missingJudges,
    humanTotal: human.length,
    humanRaised: human.filter(item => item.raised).length,
    humanSurvivedRefuter: human.filter(item => item.survivedRefuter).length,
    automatedTotal: findings.length,
    automatedRefuted: findings.filter(finding => finding.verdict === 'refuted').length,
    automatedWithoutHumanMatch: findings.filter(finding => !matchedIds.has(finding.id)).length,
    refutedMatched: findings.filter(finding => finding.verdict === 'refuted' && matchedIds.has(finding.id)).length,
    refutedUnmatched: findings.filter(finding => finding.verdict === 'refuted' && !matchedIds.has(finding.id)).length,
    human,
    findings: findings.map(({ id, judge, severity, path, line, claim, verdict }) => ({ id, judge, severity, path, line, claim, verdict })),
  }
}

const results = (await pipeline(args.prs, pr => calibrate(pr))).filter(Boolean)
const gc = await runCommand(`${FACTORY} gc${REPO}`, 'gc', 'Match', {
  type: 'object',
  properties: { dropped: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
})
if (gc && gc.dropped && gc.dropped.length) incidents.push({ kind: 'worktree-not-cleaned', dropped: gc.dropped })
const measured = results.filter(result => result.status === 'measured')
const sum = key => measured.reduce((total, result) => total + result[key], 0)
const humanTotal = sum('humanTotal')

return {
  incidents,
  prs: results.map(result => ({ pr: result.pr, status: result.status })),
  humanTotal,
  recallRaised: humanTotal ? sum('humanRaised') / humanTotal : null,
  recallAfterRefuter: humanTotal ? sum('humanSurvivedRefuter') / humanTotal : null,
  automatedTotal: sum('automatedTotal'),
  automatedRefuted: sum('automatedRefuted'),
  refutedMatched: sum('refutedMatched'),
  refutedUnmatched: sum('refutedUnmatched'),
  judges: measured.length === results.length ? JUDGES.map(judge => judge.key) : [],
  automatedWithoutHumanMatch: sum('automatedWithoutHumanMatch'),
  results,
}
