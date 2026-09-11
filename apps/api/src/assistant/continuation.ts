/** Selected API result fields only. Never carry typed data or signatures through the model. */
/**
 * Which shape the browser must verify before it asks anyone to sign.
 *
 * The review screen checks the stored mandate against an expected structure, so
 * it needs to know which structure to expect. Defaulting an absent value to the
 * Venus scope keeps every continuation stored before this existed working, and
 * fails safe: the guardian check is the stricter of the two.
 */
export type MandateScope = 'venus_repay' | 'token_transfer'

export interface MandateContinuation {
  kind: 'sign_mandate'
  scope: MandateScope
  authorizationId: string
  chainId: 56 | 97
  account: string
  manager: string
}

export function mandateContinuation(value: unknown): MandateContinuation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const action = value as Record<string, unknown>
  const address = (entry: unknown): entry is string =>
    typeof entry === 'string' && /^0x[0-9a-f]{40}$/i.test(entry) && !/^0x0{40}$/i.test(entry)
  const scope = action.scope === undefined ? 'venus_repay' : action.scope
  if (
    action.kind !== 'sign_mandate' ||
    (scope !== 'venus_repay' && scope !== 'token_transfer') ||
    typeof action.authorizationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      action.authorizationId,
    ) ||
    (action.chainId !== 56 && action.chainId !== 97) ||
    !address(action.account) ||
    !address(action.manager)
  )
    return
  return {
    kind: 'sign_mandate',
    scope,
    authorizationId: action.authorizationId.toLowerCase(),
    chainId: action.chainId,
    account: action.account.toLowerCase(),
    manager: action.manager.toLowerCase(),
  }
}
