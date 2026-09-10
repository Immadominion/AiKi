import {
  BaseError,
  CallExecutionError,
  createPublicClient,
  ExecutionRevertedError,
  HttpRequestError,
  http,
  RpcRequestError,
  TimeoutError,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { runLocalRevertDiagnostic } from './strategy-journey-diagnostics.test-support.js'

// These addresses/URLs identify mocked requests only. No transport connects to them.
const url = 'http://127.0.0.1:18545'
const to = `0x${'11'.repeat(20)}` as const
const body = { method: 'eth_call', params: [{ to, data: '0x12345678' }, '0x1'] }
const rpcError = (code: number, data?: unknown) =>
  new RpcRequestError({
    body,
    url,
    error: { code, message: 'execution reverted', ...(data === undefined ? {} : { data }) },
  })

describe('local journey diagnostic transport boundary', () => {
  it.each([
    ['timeout', new TimeoutError({ body, url })],
    ['wrapped timeout', new CallExecutionError(new TimeoutError({ body, url }), { to })],
    ['HTTP failure', new HttpRequestError({ url, status: 503, details: 'execution reverted' })],
    ['internal upstream RPC failure', rpcError(-32000, '0x12345678')],
    ['message-only revert', new Error('execution reverted')],
    ['inferred viem revert', new ExecutionRevertedError({ message: 'execution reverted' })],
    ['forged revert shape', { name: 'RpcRequestError', code: 3, data: '0x' }],
    ['revert with missing data', rpcError(3)],
    ['revert with malformed bytes', rpcError(3, '0x123')],
    ['revert with object data', rpcError(3, { data: '0x12345678' })],
    ['transport wrapping a revert', new HttpRequestError({ url, cause: rpcError(3, '0x') })],
  ])('never adds an EVM trace after %s', async (_label, error) => {
    const trace = vi.fn(async () => {})
    expect(await runLocalRevertDiagnostic(error, trace)).toBe('skipped')
    expect(trace).not.toHaveBeenCalled()
  })

  it.each(['0x', '0x12345678'])(
    'traces a concrete RPC revert with %s data exactly once',
    async (data) => {
      const error = new CallExecutionError(
        new ExecutionRevertedError({ cause: rpcError(3, data) }),
        { to },
      )
      const trace = vi.fn(async () => {})
      expect(await runLocalRevertDiagnostic(error, trace)).toBe('traced')
      expect(trace).toHaveBeenCalledTimes(1)
    },
  )

  it('fails closed for cyclic and over-deep cause chains', async () => {
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    let deep: unknown = rpcError(3, '0x')
    for (let n = 0; n < 20; n++) deep = { cause: deep }
    for (const error of [cyclic, deep]) {
      const trace = vi.fn(async () => {})
      expect(await runLocalRevertDiagnostic(error, trace)).toBe('skipped')
      expect(trace).not.toHaveBeenCalled()
    }
  })

  it('a failed diagnostic cannot replace the original EVM failure', async () => {
    const error = rpcError(3, '0x')
    expect(
      await runLocalRevertDiagnostic(error, async () => {
        throw new Error('Trace transport failed')
      }),
    ).toBe('unavailable')
    expect(error.code).toBe(3)
  })

  it('malformed error inspection cannot replace the original failure or start a trace', async () => {
    const error = Object.defineProperty(new Error('Original call failed'), 'cause', {
      get() {
        throw new Error('Unreadable cause')
      },
    })
    const trace = vi.fn(async () => {})
    expect(await runLocalRevertDiagnostic(error, trace)).toBe('unavailable')
    expect(trace).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP timeout', 'timeout', 'skipped'],
    ['internal RPC error', -32000, 'skipped'],
    ['explicit EVM revert', 3, 'traced'],
  ] as const)(
    'classifies actual viem call wrapping for %s using only a mocked fetch',
    async (_label, failure, expected) => {
      const fetchFn = vi.fn(async () => {
        if (failure === 'timeout') throw new TimeoutError({ body, url })
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: failure,
            message: 'execution reverted',
            data: '0x12345678',
          },
        })
      })
      const reader = createPublicClient({ transport: http(url, { fetchFn, retryCount: 0 }) })
      const error = await reader
        .call({ to, data: '0x12345678', blockNumber: 1n })
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(BaseError)
      const trace = vi.fn(async () => {})
      expect(await runLocalRevertDiagnostic(error, trace)).toBe(expected)
      expect(trace).toHaveBeenCalledTimes(expected === 'traced' ? 1 : 0)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    },
  )
})
