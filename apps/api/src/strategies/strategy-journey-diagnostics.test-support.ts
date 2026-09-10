import {
  ExecutionRevertedError,
  HttpRequestError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
} from 'viem'

function confirmedEvmRevert(error: unknown): boolean {
  const seen = new Set<object>()
  let cursor = error
  let confirmed = false
  for (let depth = 0; depth < 16; depth++) {
    if (cursor === null || typeof cursor !== 'object') return confirmed
    if (seen.has(cursor)) return false
    seen.add(cursor)
    if (
      cursor instanceof TimeoutError ||
      cursor instanceof HttpRequestError ||
      cursor instanceof SocketClosedError ||
      cursor instanceof WebSocketRequestError
    )
      return false
    if (cursor instanceof RpcRequestError) {
      // viem can infer ExecutionRevertedError from message text. Require the
      // actual RPC revert code and byte data instead of accepting that inference.
      if (
        cursor.code !== ExecutionRevertedError.code ||
        typeof cursor.data !== 'string' ||
        !/^0x(?:[0-9a-f]{2})*$/i.test(cursor.data)
      )
        return false
      confirmed = true
    }
    cursor = 'cause' in cursor ? cursor.cause : undefined
  }
  return false
}

/** Test-only diagnostics; a trace must never change the original call outcome. */
export async function runLocalRevertDiagnostic(
  error: unknown,
  trace: () => Promise<void>,
): Promise<'traced' | 'skipped' | 'unavailable'> {
  // A caller timeout does not prove that Anvil stopped the original EVM call.
  // Adding a trace then can reintroduce concurrent backend access after the
  // serial HTTP queue has released its failed request.
  try {
    if (!confirmedEvmRevert(error)) return 'skipped'
    await trace()
    return 'traced'
  } catch {
    return 'unavailable'
  }
}
