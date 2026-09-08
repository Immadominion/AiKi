export interface ToolOutcome {
  tool: string
  mutating: boolean
  ok: boolean
  body: unknown
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Only explicitly selected fields reach the fallback, never credentials or arbitrary JSON. */
const text = (value: unknown, limit = 180): string =>
  typeof value === 'string'
    ? value
        .replace(/[\r\n\t]/g, ' ')
        .replace(/[\\`*_[\]<>]/g, '')
        .replaceAll(String.fromCharCode(0x2014), ',')
        .slice(0, limit)
        .trim()
    : ''

const recordId = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null

const points = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const TASK_TOOLS = new Set([
  'hire_agent',
  'hire_person',
  'post_task',
  'claim_task',
  'submit_task',
  'accept_task',
  'decline_task',
  'release_task',
])

const TASK_STATUS: Record<string, string> = {
  OPEN: 'waiting for someone to take the task',
  CLAIMED: 'assigned, awaiting delivery',
  SUBMITTED: 'a result is ready for your review',
  SETTLED: 'payment released',
  CANCELLED: 'cancelled',
  DISPUTED: 'disputed',
}

const TOOL_NAMES: Record<string, string> = {
  hire_agent: 'Agent task',
  hire_person: 'Provider task',
  post_task: 'New task',
  create_spending_mandate: 'Work budget',
  create_mandate: 'Mandate',
  hire: 'Job',
  watch_position: 'Watch',
  stop_watching: 'Stop watch',
  revoke_mandate: 'Revoke mandate',
  accept_task: 'Accept work',
  decline_task: 'Dispute work',
  release_task: 'Release payment',
}

function taskSummary(body: Record<string, unknown>): string {
  const id = recordId(body.id)
  if (!id) return 'Task request returned without a task ID. Check Work before trying it again.'
  const status = typeof body.status === 'string' ? TASK_STATUS[body.status] : undefined
  const lines = [`Task \`${id}\`${status ? `: ${status}` : ': check Work for its current status'}.`]
  const held = points(body.heldPoints)
  if (held !== null) {
    const provider = points(body.pricePoints)
    const fee = points(body.feePoints)
    lines.push(
      `${held} points held${provider !== null && fee !== null && provider + fee === held ? ` (${provider} for the provider + ${fee} AiKi fee)` : ''}.`,
    )
  }
  const dispatch = text(body.dispatchNote)
  if (dispatch) lines.push(`Dispatch report: ${dispatch}`)
  const submission = text(body.submission, 360)
  if (submission && ['SUBMITTED', 'SETTLED', 'DISPUTED'].includes(String(body.status)))
    lines.push(`Provider response excerpt, not independently verified: "${submission}"`)
  return lines.join(' ')
}

function describe(outcome: ToolOutcome): string {
  const body = object(outcome.body)
  const error = typeof body.error === 'string' ? body.error : object(body.error).message
  if (!outcome.ok || body.error)
    return `${TOOL_NAMES[outcome.tool] ?? 'Tool request'} was not confirmed: ${text(error) || 'the API did not return a successful result'}.`
  if (TASK_TOOLS.has(outcome.tool)) return taskSummary(body)
  const id = recordId(body.id)
  if (outcome.tool === 'create_spending_mandate')
    return id ? `Created work budget \`${id}\`.` : 'Work budget request returned without an ID.'
  if (outcome.tool === 'create_mandate')
    return id
      ? `Created mandate \`${id}\`. This chat has not signed it in your wallet.`
      : 'Mandate request returned without an ID.'
  if (outcome.tool === 'hire')
    return id ? `Created job [${id}](/jobs/${id}).` : 'Job request returned without an ID.'
  if (outcome.tool === 'my_tasks') {
    const tasks = Array.isArray(body.tasks) ? body.tasks : []
    return tasks.length
      ? `Your work: ${tasks
          .slice(0, 3)
          .map((task) => taskSummary(object(task)))
          .join(' ')}`
      : 'No tasks were returned for your account.'
  }
  if (outcome.tool === 'search_agents') {
    const results = Array.isArray(body.results) ? body.results : []
    const agents = results.slice(0, 3).map((value) => {
      const agent = object(value)
      const agentId =
        typeof agent.agentId === 'string' && /^\d+$/.test(agent.agentId) ? agent.agentId : null
      const name = text(agent.name, 80) || 'Agent'
      return agentId ? `[${name}](/registry/${agentId})` : name
    })
    return agents.length
      ? `Search returned: ${agents.join(', ')}.`
      : 'This search returned no agents.'
  }
  return `${TOOL_NAMES[outcome.tool] ?? 'Tool request'} returned successfully${id ? ` for \`${id}\`` : ''}.`
}

/** Finishing a turn does not undo its tools. Preserve confirmed work without another model call. */
export function stoppedReply(reason: 'budget' | 'rounds', outcomes: ToolOutcome[]): string {
  const opening =
    reason === 'budget'
      ? 'I stopped before this answer could cost more than the points held for it.'
      : 'I reached the step limit for this turn and stopped.'
  if (outcomes.length === 0) return `${opening} No tools were run in this turn.`

  // Keep confirmed mutations ahead of failures and large discovery responses.
  const confirmed = (outcome: ToolOutcome) => outcome.ok && !object(outcome.body).error
  const important = outcomes.filter((outcome) => outcome.mutating && confirmed(outcome))
  const failures = outcomes.filter((outcome) => !confirmed(outcome))
  const others = outcomes.filter((outcome) => !outcome.mutating && confirmed(outcome))
  const selected = [...important.slice(-8), ...failures.slice(-3), ...others.slice(-3)]
  const lines: string[] = []
  let remaining = 3_600
  for (const outcome of selected) {
    const line = `- ${describe(outcome)}`
    // Whole summaries only: never cut an ID or a link in half. Leave room in
    // the next turn's conversation limit for the person's original request.
    if (line.length > remaining) continue
    lines.push(line)
    remaining -= line.length + 1
  }
  const details = lines.join('\n')
  const omitted = outcomes.length - lines.length
  return [
    opening,
    details,
    ...(omitted > 0 ? [`${omitted} other tool results are omitted from this summary.`] : []),
    '[Open your work](/work) to review existing tasks before creating another. A stopped reply does not cancel work already created.',
  ].join('\n\n')
}
