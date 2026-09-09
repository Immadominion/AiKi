import { boundedText, type CatalogFetch, publicFetch, safeEndpoint } from './transport.js'
import { CatalogError, type CatalogTool, type JsonObject, object, string } from './types.js'

const MAX_RESPONSE = 512 * 1024
const VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26'])

/** Ignore server requests/notifications. Never respond to sampling, elicitation or roots. */
export async function rpcResult(response: Response, id: number): Promise<JsonObject> {
  if (!response.ok) {
    await response.body?.cancel()
    const status = response.status
    if (status === 401 || status === 403)
      throw new CatalogError(
        424,
        'PROVIDER_AUTH_REQUIRED',
        'This provider requires its own sign-in.',
      )
    if (status === 402)
      throw new CatalogError(
        424,
        'PROVIDER_PAYMENT_REQUIRED',
        'This provider requires payment. AiKi has not made a payment.',
      )
    if (status === 429)
      throw new CatalogError(
        429,
        'PROVIDER_RATE_LIMIT',
        'The provider is busy. Try again later.',
        60,
      )
    throw new CatalogError(
      502,
      'PROVIDER_UNAVAILABLE',
      'The provider did not accept the capability request.',
    )
  }
  const check = (data: unknown): JsonObject | null => {
    const envelope = object(data)
    if (envelope.jsonrpc !== '2.0' || envelope.id !== id) return null
    if (envelope.error) {
      const code = object(envelope.error).code
      if (code === 401 || code === 403)
        throw new CatalogError(
          424,
          'PROVIDER_AUTH_REQUIRED',
          'This provider requires its own sign-in.',
        )
      if (code === 402)
        throw new CatalogError(
          424,
          'PROVIDER_PAYMENT_REQUIRED',
          'This provider requires payment. No payment was made.',
        )
      throw new CatalogError(502, 'PROVIDER_RPC_ERROR', 'The provider returned a protocol error.')
    }
    if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result))
      return null
    return object(envelope.result)
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    let data: unknown
    try {
      data = JSON.parse(await boundedText(response, MAX_RESPONSE))
    } catch (error) {
      if (error instanceof CatalogError) throw error
      throw new CatalogError(502, 'INVALID_PROTOCOL', 'The provider returned invalid JSON.')
    }
    const result = check(data)
    if (result) return result
  } else if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body?.getReader()
    if (!reader)
      throw new CatalogError(502, 'INVALID_PROTOCOL', 'The provider returned an empty stream.')
    const decoder = new TextDecoder()
    let buffer = ''
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE)
          throw new CatalogError(502, 'RESPONSE_TOO_LARGE', 'The provider response is too large.')
        buffer += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const separator = /\r?\n\r?\n/.exec(buffer)
          if (!separator || separator.index === undefined) break
          const event = buffer.slice(0, separator.index)
          buffer = buffer.slice(separator.index + separator[0].length)
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
          if (!data) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }
          const result = check(parsed)
          if (result) return result
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  } else {
    await response.body?.cancel()
  }
  throw new CatalogError(502, 'INVALID_PROTOCOL', 'No matching MCP response was received.')
}

export interface McpSession {
  version: string
  tools: CatalogTool[]
  truncated: boolean
  call(name: string, args: JsonObject): Promise<JsonObject>
  close(): void
}

/** One bounded, private protocol session per check/call. Never cache session IDs. */
export async function connectMcp(
  endpoint: string,
  fetcher: CatalogFetch = publicFetch,
): Promise<McpSession> {
  const url = safeEndpoint(endpoint)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 18_000)
  timer.unref?.()
  let sessionId = ''
  let version = ''
  const post = async (method: string, params: JsonObject, id?: number) => {
    const response = await fetcher(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(version ? { 'mcp-protocol-version': version } : {}),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
    })
    return response
  }
  const close = () => {
    clearTimeout(timer)
    controller.abort()
  }
  try {
    const response = await post(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'AiKi-readonly-connector', version: '1.0.0' },
      },
      1,
    )
    const header = response.headers.get('mcp-session-id')
    if (header && /^[\x21-\x7e]{1,512}$/.test(header)) sessionId = header
    const initialization = await rpcResult(response, 1)
    version = string(initialization.protocolVersion, 20)
    if (!VERSIONS.has(version))
      throw new CatalogError(
        422,
        'UNSUPPORTED_MCP_VERSION',
        'This MCP version is not supported by the connector.',
      )
    const notification = await post('notifications/initialized', {})
    if (!notification.ok) await rpcResult(notification, 0)
    else await notification.body?.cancel()
    const result = await rpcResult(await post('tools/list', {}, 2), 2)
    if (!Array.isArray(result.tools))
      throw new CatalogError(502, 'INVALID_PROTOCOL', 'The provider did not return a tool list.')
    const seen = new Set<string>()
    const tools: CatalogTool[] = []
    for (const raw of result.tools.slice(0, 100)) {
      const tool = object(raw)
      const name = string(tool.name, 128)
      if (!name || seen.has(name) || name !== tool.name) continue
      seen.add(name)
      const inputSchema = object(tool.inputSchema)
      if (JSON.stringify(inputSchema).length > 16_384) continue
      tools.push({
        name,
        description: string(tool.description, 1200),
        inputSchema,
        readAllowed: false,
      })
    }
    return {
      version,
      tools,
      truncated: result.tools.length > 100 || Boolean(result.nextCursor),
      call: async (name, args) =>
        rpcResult(await post('tools/call', { name, arguments: args }, 3), 3),
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
