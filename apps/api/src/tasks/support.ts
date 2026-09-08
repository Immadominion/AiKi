import { guardedFetch } from '../net/guard.js'
import { DISPATCH_PROTOCOL } from './dispatch.js'
import { isTaskKind } from './kinds.js'

export interface AgentTaskContact {
  owner: string
  endpoint: string
  live: boolean
  /** Production always sets this. Optional only for existing injected test contacts. */
  compatible?: boolean
  reason?: string
  protocol?: string
  inputHint?: string
  kinds?: string[]
}

const MAX_CAPABILITY_BYTES = 16_384

async function capability(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_CAPABILITY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } finally {
    reader.releaseLock()
  }
}

/** Read registered endpoints only; HTTP liveness by itself is not a hiring protocol. */
export async function resolveTaskEndpoint(
  services: unknown,
  read: typeof guardedFetch = guardedFetch,
): Promise<Omit<AgentTaskContact, 'owner' | 'live'>> {
  const endpoints = Array.isArray(services)
    ? [
        ...new Set(
          services
            .map((service) => service?.endpoint)
            .filter(
              (endpoint): endpoint is string =>
                typeof endpoint === 'string' && /^https?:\/\//i.test(endpoint),
            ),
        ),
      ]
        .sort()
        .slice(0, 8)
    : []
  const answers = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const metadata = await capability(
          await read(endpoint, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(4_000),
          }),
        )
        if (metadata?.taskProtocol !== DISPATCH_PROTOCOL) return null
        const inputHint =
          typeof metadata.taskInputHint === 'string'
            ? metadata.taskInputHint.trim().slice(0, 300)
            : undefined
        const kinds = Array.isArray(metadata.taskKinds)
          ? metadata.taskKinds.filter(isTaskKind)
          : undefined
        return {
          endpoint,
          compatible: true,
          protocol: DISPATCH_PROTOCOL,
          ...(inputHint ? { inputHint } : {}),
          ...(kinds?.length ? { kinds } : {}),
        }
      } catch {
        return null
      }
    }),
  )
  return (
    answers.find((answer) => answer !== null) ?? {
      endpoint: '',
      compatible: false,
      reason: endpoints.length
        ? 'This agent does not currently advertise support for AiKi task delivery.'
        : 'This agent has not declared a usable task endpoint.',
    }
  )
}
