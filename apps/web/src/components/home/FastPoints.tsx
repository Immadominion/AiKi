import type { AssistantTurn, FastConversationMessage } from '../../lib/api'

const conversationId = (value: string | null) =>
  value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null

export function addPointsHref(id: string) {
  const valid = conversationId(id)
  return `/credits${valid ? `?conversation=${valid}` : ''}#credit-add-title`
}

/** Only the conversation ID travels through checkout, never arbitrary redirects or message text. */
export function fastReturnHref(search: string) {
  const id = conversationId(new URLSearchParams(search).get('conversation'))
  return id ? `/app?conversation=${id}` : '/app'
}

function insufficientContext(message: string) {
  const match =
    /^This turn needs (\d+) points available; you have (\d+)\. No points were charged and no tools ran\. Add points to continue\.$/.exec(
      message,
    )
  return Boolean(
    match &&
      Number.isSafeInteger(Number(match[1])) &&
      Number.isSafeInteger(Number(match[2])) &&
      Number(match[1]) > Number(match[2]),
  )
}

export function errorNeedsPoints(code: string | undefined, message: string) {
  return (
    code === 'ASSISTANT_NO_CREDIT' ||
    (code === 'ASSISTANT_BUDGET_TOO_SMALL' && insufficientContext(message))
  )
}

/** Older History lacks error codes. Match only the server's failed, zero-usage refusal. */
export function messageNeedsPoints(message: FastConversationMessage) {
  return (
    message.role === 'assistant' &&
    message.status === 'failed' &&
    message.cost?.points === 0 &&
    !message.cost.pendingPoints &&
    Array.isArray(message.steps) &&
    message.steps.length === 0 &&
    insufficientContext(message.content)
  )
}

export function fastCostSummary(cost: AssistantTurn['cost']) {
  if (
    ![cost.points, cost.balance, cost.held, cost.pendingPoints ?? 0].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return 'Billing details unavailable.'
  if (cost.pendingPoints)
    return `${cost.points.toLocaleString()} points charged so far · ${cost.pendingPoints.toLocaleString()} points still reserved pending confirmation`
  return `${cost.points === 0 ? 'No points charged' : `${cost.points.toLocaleString()} points charged`} · ${cost.balance.toLocaleString()} points remaining after this turn`
}

export function FastPointsRecovery({ id }: { id: string }) {
  return (
    <div className="mt-3 space-y-2">
      <a
        href={addPointsHref(id)}
        className="inline-flex min-h-11 items-center justify-center rounded-xl bg-ink-app px-4 py-3 text-sm font-bold text-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
      >
        Add points
      </a>
      <p className="text-muted m-0 text-xs leading-relaxed">
        Buy AiKi points with USDT at checkout. Holding USDT in your wallet does not add points.
      </p>
    </div>
  )
}
