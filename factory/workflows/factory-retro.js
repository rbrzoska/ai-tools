export const meta = {
  name: 'factory-retro',
  description: 'Factory: retrospective of the factory itself - recurring problems from the ledger and run reports, each with a proposed fix',
  whenToUse: 'After a batch of runs, or when the same problem keeps coming back. args: { minOccurrences? }.',
  phases: [
    { title: 'Retro', detail: 'read ledger and reports, propose fixes' },
    { title: 'Check', detail: 'verify each cited occurrence exists' },
  ],
}

const AGENT_DIR = '~/.claude/skills/factory/agents'
const LEDGER = '~/.factory/ledger.jsonl'

const RETRO = {
  type: 'object',
  required: ['problems'],
  properties: {
    problems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'problem', 'occurrences', 'fixKind', 'fix', 'measure'],
        properties: {
          title: { type: 'string' },
          problem: { type: 'string' },
          occurrences: { type: 'array', items: { type: 'string' } },
          fixKind: { enum: ['gate', 'script', 'prompt', 'process'] },
          fix: { type: 'string' },
          measure: { type: 'string' },
        },
      },
    },
  },
}

const CHECKED = {
  type: 'object',
  required: ['occurrences'],
  properties: {
    occurrences: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'supports'],
        properties: { ref: { type: 'string' }, supports: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
  },
}

const minOccurrences = (args && args.minOccurrences) ?? 2
const incidents = []

async function role(agentType, prompt, opts) {
  try {
    return await agent(prompt, { ...opts, agentType })
  } catch (error) {
    if (!String(error).includes('not found')) throw error
    incidents.push({ kind: 'agent-not-in-registry', agentType, label: opts.label })
    return agent(`Before anything else read ${AGENT_DIR}/${agentType}.md. Its body is your role; follow it exactly.\n\n${prompt}`, opts)
  }
}

phase('Retro')
const retro = await role('factory-retro', 'Run the retrospective now.', { model: 'opus', label: 'retro', phase: 'Retro', schema: RETRO })
if (!retro) return { status: 'failed', incidents }

phase('Check')
const checked = await pipeline(retro.problems, problem =>
  agent(
    `A retrospective claims this problem of an agent factory:\n${JSON.stringify(problem, null, 2)}\n\nFor each entry in "occurrences" open what it cites (ledger:<n> means line n of ${LEDGER}, counting from 1; otherwise it is a file path) and decide whether that line or file really shows this problem. Do not judge the proposed fix.`,
    { model: 'sonnet', label: `check:${problem.title.slice(0, 40)}`, phase: 'Check', schema: CHECKED },
  ).then(result => {
    const supported = result ? result.occurrences.filter(item => item.supports).map(item => item.ref) : []
    return {
      ...problem,
      supportedOccurrences: supported,
      unsupportedOccurrences: result ? result.occurrences.filter(item => !item.supports) : [],
      recurring: new Set(supported).size >= minOccurrences,
    }
  }))

const problems = checked.filter(Boolean)
return {
  status: 'done',
  minOccurrences,
  recurring: problems.filter(problem => problem.recurring),
  single: problems.filter(problem => !problem.recurring),
  incidents,
}
