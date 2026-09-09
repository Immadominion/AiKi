/** Selected API result fields only. Never carry typed data or signatures through the model. */
export interface MandateContinuation {
  kind: 'sign_mandate'
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
  if (
    action.kind !== 'sign_mandate' ||
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
    authorizationId: action.authorizationId.toLowerCase(),
    chainId: action.chainId,
    account: action.account.toLowerCase(),
    manager: action.manager.toLowerCase(),
  }
}
