/**
 * HTTP probing for AiKi's liveness verification.
 *
 * Deliberately conservative about other people's infrastructure: short timeouts,
 * bounded body reads, bounded concurrency, and a User-Agent that identifies us and
 * links to an explanation. We are probing tens of thousands of third-party endpoints;
 * being a bad citizen would be both rude and a fast route to being blocked.
 */

import {
  type DeclaredService,
  type ProbeSample,
  type ProbeVerdict,
  classify,
  d4_isZeroCostUri,
  d8_reciprocalProof,
  md5,
} from './detect.js'

export const USER_AGENT = 'AiKi-Prober/0.1 (+https://github.com/Immadominion/AiKi)'

const TIMEOUT_MS = 8_000
/** Cap body reads — some endpoints will happily stream forever. */
const MAX_BODY_BYTES = 256 * 1024

export interface FetchResult {
  status: number
  body: string
  contentType: string | null
  latencyMs: number
  error?: string
}

/**
 * Uses Node's built-in fetch (undici under the hood) — it follows redirects by
 * default, which matters because many declared endpoints redirect, and it keeps
 * the dependency surface at zero.
 */
export async function fetchOnce(url: string): Promise<FetchResult> {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    // Bound the read — some endpoints will happily stream forever.
    const reader = res.body?.getReader()
    let body = ''
    if (reader) {
      const decoder = new TextDecoder()
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes <= MAX_BODY_BYTES) body += decoder.decode(value, { stream: true })
        else {
          await reader.cancel()
          break
        }
      }
    }

    return {
      status: res.status,
      body,
      contentType: res.headers.get('content-type'),
      latencyMs: Date.now() - started,
    }
  } catch (err) {
    return {
      status: 0,
      body: '',
      contentType: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Build the three D1 probe URLs from one endpoint.
 *
 * We vary whatever identifier the URL carries — a query param or the last path
 * segment. If we cannot find one to vary, D1 cannot run and the caller must not
 * claim the endpoint is agent-specific.
 */
export function d1Variants(endpoint: string): { label: ProbeSample['label']; url: string }[] {
  const out: { label: ProbeSample['label']; url: string }[] = [
    { label: 'valid', url: endpoint },
  ]

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return out
  }

  const idParam = [...url.searchParams.keys()].find((k) => /^(id|agentid|agent_id|token_id)$/i.test(k))

  if (idParam) {
    const nonsense = new URL(url)
    nonsense.searchParams.set(idParam, '999999999')
    const nonNumeric = new URL(url)
    nonNumeric.searchParams.set(idParam, 'abc')
    out.push({ label: 'nonsense', url: nonsense.toString() })
    out.push({ label: 'nonNumeric', url: nonNumeric.toString() })
    return out
  }

  const segments = url.pathname.split('/').filter(Boolean)
  const last = segments.at(-1)
  if (last && /^\d+$/.test(last)) {
    const swap = (v: string) => {
      const u = new URL(url)
      u.pathname = `/${[...segments.slice(0, -1), v].join('/')}`
      return u.toString()
    }
    out.push({ label: 'nonsense', url: swap('999999999') })
    out.push({ label: 'nonNumeric', url: swap('abc') })
  }

  return out
}

export interface ProbeAgentInput {
  agentId: string
  registry: string
  services: DeclaredService[]
  /** The scheme of the agentURI, so D4 can be reported honestly. */
  agentUri?: string
}

export interface ProbeAgentResult {
  agentId: string
  verdict: ProbeVerdict
  samples: ProbeSample[]
  /** D8 — the reciprocal /.well-known proof. */
  reciprocal?: { verified: boolean; detail: string }
  /** D4 — true when the registration file cost no network I/O to "resolve". */
  registrationWasZeroCost: boolean
  probedAt: string
}

export async function probeAgent(input: ProbeAgentInput): Promise<ProbeAgentResult> {
  const probedAt = new Date().toISOString()
  const registrationWasZeroCost = input.agentUri ? d4_isZeroCostUri(input.agentUri) : false

  const network = input.services.filter(
    (s) => /^https?:\/\//i.test(s.endpoint) && s.transport !== 'stdio',
  )

  // Static rules can decide without touching the network.
  if (network.length === 0) {
    return {
      agentId: input.agentId,
      verdict: classify({ services: input.services, samples: [] }),
      samples: [],
      registrationWasZeroCost,
      probedAt,
    }
  }

  const primary = network[0]
  if (!primary) {
    return {
      agentId: input.agentId,
      verdict: classify({ services: input.services, samples: [] }),
      samples: [],
      registrationWasZeroCost,
      probedAt,
    }
  }

  const variants = d1Variants(primary.endpoint)
  const samples: ProbeSample[] = []
  let primaryBody = ''

  for (const v of variants) {
    const r = await fetchOnce(v.url)
    if (v.label === 'valid') primaryBody = r.body
    samples.push({
      label: v.label,
      url: v.url,
      status: r.status,
      bodyHash: md5(r.body),
      bodyLength: r.body.length,
      contentType: r.contentType,
      latencyMs: r.latencyMs,
      ...(r.error ? { error: r.error } : {}),
    })
  }

  const verdict = classify({ services: input.services, samples, primaryBody })

  // D8 — only worth checking when there is a real host to check against.
  let reciprocal: ProbeAgentResult['reciprocal']
  try {
    const origin = new URL(primary.endpoint).origin
    const wk = await fetchOnce(`${origin}/.well-known/agent-registration.json`)
    if (wk.status >= 200 && wk.status < 300 && wk.body) {
      reciprocal = d8_reciprocalProof(JSON.parse(wk.body), {
        agentId: input.agentId,
        agentRegistry: input.registry,
      })
    } else {
      reciprocal = { verified: false, detail: 'No /.well-known/agent-registration.json served.' }
    }
  } catch {
    reciprocal = { verified: false, detail: 'Reciprocal proof could not be evaluated.' }
  }

  return {
    agentId: input.agentId,
    verdict,
    samples,
    reciprocal,
    registrationWasZeroCost,
    probedAt,
  }
}

/** Bounded-concurrency map. Keeps us from hammering a single host. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      const item = items[i]
      if (i >= items.length || item === undefined) return
      out[i] = await fn(item, i)
    }
  })
  await Promise.all(workers)
  return out
}
