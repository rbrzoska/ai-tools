export const meta = {
  name: 'factory-spec',
  description: 'Factory: grill a task, then write spec.md and a ticket plan into the run directory',
  whenToUse: 'First half of a factory run. args: { run, task, answers? }. Returns needs-answers or spec-ready.',
  phases: [
    { title: 'Grill', detail: 'find facts, surface open decisions' },
    { title: 'Spec', detail: 'acceptance criteria and test seams' },
    { title: 'Plan', detail: 'tracer-bullet tickets' },
  ],
}

const GRILL = {
  type: 'object',
  required: ['size', 'risk', 'facts', 'questions'],
  properties: {
    size: { enum: ['S', 'M', 'L'] },
    risk: { enum: ['low', 'medium', 'high'] },
    domainContexts: { type: 'array', items: { type: 'string' } },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fact', 'source'],
        properties: { fact: { type: 'string' }, source: { type: 'string' } },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'question', 'recommended', 'risk', 'why'],
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          recommended: { type: 'string' },
          risk: { enum: ['low', 'high'] },
          why: { type: 'string' },
        },
      },
    },
  },
}

const SPEC = {
  type: 'object',
  required: ['specPath', 'acceptanceCriteria', 'seams', 'outOfScope'],
  properties: {
    specPath: { type: 'string' },
    acceptanceCriteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    seams: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
}

const PLAN = {
  type: 'object',
  required: ['planPath', 'tickets'],
  properties: {
    planPath: { type: 'string' },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'brief', 'acceptanceCriteriaIds', 'blockedBy'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string' },
          acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
          blockedBy: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

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

const { run, task } = args
const answers = args.answers || {}
const context = `Run directory: ${run.runDir}\nWorktree (code at base commit ${run.baseSha}): ${run.worktree}`

phase('Grill')
const grill = await role('factory-grill', `${context}\n\nTask:\n${task}`, { model: 'opus',
  label: 'grill',
  schema: GRILL,
})
if (!grill) return { status: 'failed', stage: 'grill' }

const unanswered = grill.questions.filter(question => question.risk === 'high' && !answers[question.id])
if (unanswered.length) {
  log(`${unanswered.length} high-risk question(s) need a human answer`)
  return { status: 'needs-answers', questions: unanswered, size: grill.size, risk: grill.risk }
}

const decisions = grill.questions.map(question => ({
  id: question.id,
  question: question.question,
  answer: answers[question.id] || question.recommended,
  decidedBy: answers[question.id] ? 'human' : 'default',
}))

phase('Spec')
const spec = await role('factory-spec', `${context}\n\nTask:\n${task}\n\nFacts:\n${JSON.stringify(grill.facts, null, 2)}\n\nSettled decisions:\n${JSON.stringify(decisions, null, 2)}`, { model: 'opus', label: 'spec', schema: SPEC },
)
if (!spec) return { status: 'failed', stage: 'spec' }

phase('Plan')
const plan = await role('factory-planner', `${context}\n\nTask size estimated by grilling: ${grill.size}`, { model: 'opus',
  label: 'plan',
  schema: PLAN,
})
if (!plan) return { status: 'failed', stage: 'plan' }

return {
  status: 'spec-ready',
  incidents,
  size: grill.size,
  risk: grill.risk,
  domainContexts: grill.domainContexts || [],
  decisions,
  spec,
  tickets: plan.tickets,
}
