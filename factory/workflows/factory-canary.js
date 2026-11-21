export const meta = {
  name: 'factory-canary',
  description: 'Factory: seed known bugs into a copy of a finished run and measure how many the tests and the judges catch',
  whenToUse: 'After factory-build passed. args: { run, bugs? }. Returns test kill rate, judge recall, the subtle bug-1 result and a canary-only level; the final trust also needs the latest calibration.',
  phases: [
    { title: 'Seed', detail: 'plant known bugs in a throwaway copy' },
    { title: 'Tests', detail: 'does each bug make the specs fail' },
    { title: 'Judge', detail: 'same judges, on the seeded copy' },
    { title: 'Match', detail: 'which bugs did a finding describe' },
  ],
}

const FACTORY = '~/.claude/skills/factory/bin/factory'
const LINE_TOLERANCE = 6
const TRUSTED_RATE = 2 / 3

const INIT = {
  type: 'object',
  required: ['canaryWorktree', 'viewDir', 'keyDir', 'baseSha'],
  properties: {
    canaryWorktree: { type: 'string' },
    viewDir: { type: 'string' },
    keyDir: { type: 'string' },
    baseSha: { type: 'string' },
    error: { type: 'string' },
  },
}

const SEEDED = {
  type: 'object',
  required: ['bugs'],
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'path', 'line', 'description'],
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
        },
      },
    },
  },
}

const TESTS = {
  type: 'object',
  required: ['bugs'],
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, killedByTests: { type: ['boolean', 'null'] } },
      },
    },
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

const MATCH = {
  type: 'object',
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['bugId', 'findingIds'],
        properties: { bugId: { type: 'string' }, findingIds: { type: 'array', items: { type: 'string' } } },
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

const { run } = args
const bugCount = args.bugs ?? 3

function runCommand(command, label, phaseTitle, schema) {
  return agent(
    `Run exactly this command with a long timeout and return its JSON output in the structured result, unchanged. Do not fix or retry anything; if it fails, put the error text in "error".\n\n${command}`,
    { model: 'haiku', effort: 'low', label, phase: phaseTitle, schema },
  )
}

const basename = path => path.split('/').pop()

phase('Seed')
const init = await runCommand(`${FACTORY} canary-init ${run.runDir}`, 'canary-init', 'Seed', INIT)
if (!init || init.error) return { status: 'failed', stage: 'canary-init', error: init && init.error }

const seeded = await role('factory-canary-seeder', `Canary worktree: ${init.canaryWorktree}\nView directory: ${init.viewDir}\nKey directory: ${init.keyDir}\nBase commit: ${init.baseSha}\nNumber of bugs to plant: ${bugCount}`, { model: 'sonnet', label: 'seed', phase: 'Seed', schema: SEEDED },
)
if (!seeded || !seeded.bugs.length) return { status: 'failed', stage: 'seed' }

phase('Tests')
const tests = await runCommand(`${FACTORY} canary-run ${run.runDir}`, 'canary-run', 'Tests', TESTS)
if (!tests || tests.error) return { status: 'failed', stage: 'canary-run', error: tests && tests.error }

const judgeContext = `Run directory: ${init.viewDir}\nWorktree: ${init.canaryWorktree}\nBase commit: ${init.baseSha}`
const judged = await parallel(JUDGES.map(judge => () =>
  role(judge.agentType, judgeContext, { model: 'opus', label: `judge:${judge.key}`, phase: 'Judge', schema: FINDINGS })
    .then(result => result && { judge: judge.key, ...result })))
const missingJudges = JUDGES.filter((_judge, index) => !judged[index]).map(judge => judge.key)
const findings = judged.filter(Boolean).flatMap(result =>
  result.findings.map((finding, index) => ({ id: `${result.judge}-${index + 1}`, judge: result.judge, ...finding })))

const byLine = Object.fromEntries(seeded.bugs.map(bug => [bug.id, []]))
for (const finding of findings) {
  if (typeof finding.line !== 'number') continue
  const nearest = seeded.bugs
    .filter(bug => basename(bug.path) === basename(finding.path))
    .map(bug => ({ id: bug.id, distance: Math.abs(finding.line - bug.line) }))
    .sort((left, right) => left.distance - right.distance)[0]
  if (nearest && nearest.distance <= LINE_TOLERANCE) byLine[nearest.id].push(finding.id)
}

const unmatched = seeded.bugs.filter(bug => !byLine[bug.id].length)
let byMeaning = {}
if (unmatched.length && findings.length) {
  const matched = await agent(
    `Seeded bugs:\n${JSON.stringify(unmatched, null, 2)}\n\nReview findings:\n${JSON.stringify(findings.map(({ id, path, line, claim, evidence }) => ({ id, path, line, claim, evidence })), null, 2)}\n\nFor each seeded bug list the ids of findings that describe that same defect: the same wrong behaviour at the same place. A finding about the same file or the same feature that names a different problem is not a match. Return an empty list when nothing matches. Do not read any files.`,
    { model: 'sonnet', label: 'match', phase: 'Match', schema: MATCH },
  )
  byMeaning = Object.fromEntries(((matched && matched.matches) || []).map(match => [match.bugId, match.findingIds]))
}

await runCommand(`${FACTORY} drop-worktree ${init.canaryWorktree}`, 'cleanup', 'Match', {
  type: 'object',
  properties: { dropped: { type: 'string' }, error: { type: 'string' } },
})

const gc = await runCommand(`${FACTORY} gc`, 'gc', 'Match', {
  type: 'object',
  properties: { dropped: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
})
if (gc && gc.dropped && gc.dropped.length) incidents.push({ kind: 'worktree-not-cleaned', dropped: gc.dropped })

const killed = Object.fromEntries(tests.bugs.map(bug => [bug.id, bug.killedByTests]))
const combined = Object.fromEntries(tests.bugs.map(bug => [bug.id, bug.inCombinedCopy !== false]))
const notJudged = seeded.bugs.filter(bug => !combined[bug.id]).map(bug => bug.id)
if (notJudged.length) incidents.push({ kind: 'canary-not-combined', bugs: notJudged })
const perBug = seeded.bugs.map(bug => ({
  ...bug,
  killedByTests: killed[bug.id] ?? null,
  caughtByLine: byLine[bug.id],
  caughtByMeaning: byMeaning[bug.id] || [],
  inCombinedCopy: combined[bug.id],
  caughtByJudges: combined[bug.id] ? byLine[bug.id].length > 0 || (byMeaning[bug.id] || []).length > 0 : null,
}))

const total = perBug.length
const testKillRate = perBug.filter(bug => bug.killedByTests === true).length / total
const inCopy = perBug.filter(bug => bug.inCombinedCopy)
const judgeRecall = inCopy.length ? inCopy.filter(bug => bug.caughtByJudges).length / inCopy.length : null
const escaped = perBug.filter(bug => bug.killedByTests !== true && !bug.caughtByJudges).map(bug => bug.id)
const trustedLayers = [testKillRate, judgeRecall].filter(rate => rate !== null && rate >= TRUSTED_RATE).length

return {
  status: 'measured',
  incidents,
  seeded: total,
  testKillRate,
  judgeRecall,
  escapedBoth: escaped,
  notJudged,
  canaryLevel: missingJudges.length || judgeRecall === null ? 'low' : ['low', 'medium', 'high'][trustedLayers],
  subtleBug: perBug.find(bug => bug.id === 'bug-1') || null,
  judges: JUDGES.map(judge => judge.key).filter(key => !missingJudges.includes(key)),
  missingJudges,
  perBug,
  unrelatedFindings: findings.length - new Set(perBug.flatMap(bug => [...bug.caughtByLine, ...bug.caughtByMeaning])).size,
}
