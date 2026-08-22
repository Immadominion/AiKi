/**
 * Liveness detection rules D1–D9.
 *
 * Each rule was derived from an observed failure in a 400-agent sample of the BSC
 * ERC-8004 registry, not from theory. See
 * research/02-ecosystem/01-erc8004-reality-on-bsc.md
 *
 * The headline rule is D1: an endpoint that returns byte-identical responses for a
 * valid id, a nonsense id and a non-numeric id is a static page, not an agent. That
 * single check reclassified 141 of 147 apparently-"live" endpoints in our sample,
 * and it is why "HTTP 200" must never render as LIVE anywhere in this product.
 */

import { createHash } from 'node:crypto'
import type { LivenessState } from '@aiki/contracts'

/** A service entry from an ERC-8004 registration file. */
export interface DeclaredService {
  name: string
  endpoint: string
  version?: string
  /** MCP descriptors carry this; "stdio" means not network-callable. */
  transport?: string
}

export interface ProbeVerdict {
  state: LivenessState
  /** Which rule decided it, e.g. "D1" — kept for provenance and auditability. */
  rule: string
  detail: string
  evidence?: Record<string, unknown>
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

// ─────────────────────────────────────────────────────────────────────────────
// Static, pre-network rules. These cost nothing and must run first.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D2 — reject unexpanded URI templates before they enter the index.
 *
 * 13 agents in our sample published the literal string
 * `https://…/a2a/agents/{agentId}/card` on-chain, never interpolated. All 404.
 * This is not an isolated bug: BNB Agent Studio's own docs recommend registering a
 * placeholder endpoint and correcting it later, so the workflow encourages it.
 */
export function d2_placeholderUrl(endpoint: string): ProbeVerdict | null {
  const m = endpoint.match(/\{[^}]+\}/)
  if (!m) return null
  return {
    state: 'PLACEHOLDER_URL',
    rule: 'D2',
    detail: `Endpoint contains an unexpanded template placeholder ${m[0]}.`,
    evidence: { placeholder: m[0], endpoint },
  }
}

/**
 * D3 — a declared service with stdio transport is real work, but it is not
 * remotely callable. A distinct state from "live" and from "broken".
 */
export function d3_notRemote(service: DeclaredService): ProbeVerdict | null {
  if (service.transport !== 'stdio') return null
  return {
    state: 'NOT_REMOTE',
    rule: 'D3',
    detail: 'Service declares stdio transport — it is a local process, not a network endpoint.',
    evidence: { transport: service.transport, name: service.name },
  }
}

/**
 * D4 — a `data:` URI resolves with zero network I/O.
 *
 * 58.3% of sampled agents inline their registration file this way, so any metric of
 * "has a resolvable registration file" is trivially inflated. This does not make the
 * agent bad; it makes the signal meaningless. Callers must exclude these from
 * resolvability statistics rather than counting them as successes.
 */
export function d4_isZeroCostUri(uri: string): boolean {
  return uri.startsWith('data:')
}

/** No service declared at all — 59.8% of the sample. */
export function declaredOnly(services: DeclaredService[]): ProbeVerdict | null {
  if (services.length > 0) return null
  return {
    state: 'DECLARED_ONLY',
    rule: 'D0',
    detail: 'Agent is registered but declares no service endpoint.',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the impostor test
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeSample {
  /** What we asked for. */
  label: 'valid' | 'nonsense' | 'nonNumeric'
  url: string
  status: number
  bodyHash: string
  bodyLength: number
  contentType: string | null
  latencyMs: number
  error?: string
}

/**
 * D1 — probe with a valid id, a nonsense id and a non-numeric id.
 * If every response is byte-identical, the endpoint is not agent-specific.
 *
 * Measured evidence: evoevo.ai returned MD5 2067c4db4f3e15616e96894ef3f89cc0 for
 * id=4538784, id=999999999 and id=abc alike. 30% of the entire BSC registry points
 * at that one domain.
 */
export function d1_impostorStatic(samples: ProbeSample[]): ProbeVerdict | null {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300)
  if (ok.length < 2) return null

  const hashes = new Set(ok.map((s) => s.bodyHash))
  if (hashes.size > 1) return null

  return {
    state: 'IMPOSTOR_STATIC',
    rule: 'D1',
    detail:
      `Returned byte-identical responses (MD5 ${ok[0]?.bodyHash.slice(0, 8)}…) for ` +
      `${ok.length} different inputs including a nonsense id. This is a static page, ` +
      'not an agent service.',
    evidence: {
      sharedHash: ok[0]?.bodyHash,
      inputsTried: ok.map((s) => s.label),
      bodyLength: ok[0]?.bodyLength,
    },
  }
}

/**
 * D5 — HTTP 200 is not liveness. Require a machine-readable content type and a
 * capability signal, not just a successful status code.
 *
 * A permissive HTML check would let every marketing page through, which is exactly
 * the failure mode D1 exists to catch, so we require structured content.
 */
export function d5_capabilityHandshake(sample: ProbeSample, body: string): ProbeVerdict | null {
  if (sample.status < 200 || sample.status >= 300) return null

  const ct = (sample.contentType ?? '').toLowerCase()
  const structured =
    ct.includes('application/json') ||
    ct.includes('application/ld+json') ||
    ct.includes('text/event-stream')

  if (!structured) {
    return {
      state: 'DEGRADED',
      rule: 'D5',
      detail:
        `Responded 200 but with content-type "${sample.contentType ?? 'none'}". ` +
        'A callable agent endpoint must return structured content, not a web page.',
      evidence: { contentType: sample.contentType },
    }
  }

  try {
    JSON.parse(body)
  } catch {
    if (!ct.includes('text/event-stream')) {
      return {
        state: 'DEGRADED',
        rule: 'D5',
        detail: 'Declared JSON content-type but the body did not parse as JSON.',
      }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// D8 — reciprocal proof
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D8 — the strongest cheap signal in ERC-8004, and almost nobody uses it.
 *
 * On-chain → file proves the owner's claim. file-at-domain → on-chain proves whoever
 * controls that domain acknowledges the agent. Together they defeat domain squatting.
 *
 * Measured: 305 of 736,076 agents (0.041%) have this. Checking it is nearly free.
 */
export function d8_reciprocalProof(
  wellKnown: unknown,
  expected: { agentId: string; agentRegistry: string },
): { verified: boolean; detail: string } {
  const doc = wellKnown as { registrations?: { agentId?: unknown; agentRegistry?: unknown }[] }
  const regs = doc?.registrations
  if (!Array.isArray(regs)) {
    return {
      verified: false,
      detail: 'No registrations array at /.well-known/agent-registration.json',
    }
  }

  const match = regs.some(
    (r) =>
      String(r?.agentId) === expected.agentId &&
      String(r?.agentRegistry).toLowerCase() === expected.agentRegistry.toLowerCase(),
  )

  return match
    ? {
        verified: true,
        detail: 'Reciprocal proof verified: endpoint domain acknowledges this agent.',
      }
    : {
        verified: false,
        detail: 'The /.well-known file exists but does not reference this agent id and registry.',
      }
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifyInput {
  services: DeclaredService[]
  samples: ProbeSample[]
  primaryBody?: string
  /**
   * D10 — how many OTHER agents in this sweep declare the identical endpoint URL.
   * One URL serving many identities cannot be agent-specific, by construction.
   */
  sharedWithOtherAgents?: number
}

/**
 * D10 — shared endpoint.
 *
 * If several distinct agents register the exact same URL with no distinguishing
 * parameter, that endpoint is not agent-specific no matter what it returns. Observed:
 * 7 agents all declaring https://q402.quackai.ai/api/relay/info, which serves a
 * static {"facilitator":"0x..."} config blob identical for every input.
 *
 * This is the companion to D1. D1 catches "same bytes for different inputs"; D10
 * catches "same URL for different agents" — which D1 cannot see, because a URL with
 * no identifier in it has nothing to vary.
 */
export function d10_sharedEndpoint(sharedWith: number): ProbeVerdict | null {
  if (sharedWith < 1) return null
  return {
    state: 'IMPOSTOR_STATIC',
    rule: 'D10',
    detail:
      `This exact endpoint URL is registered by ${sharedWith + 1} different agents. ` +
      'One URL serving many identities cannot be agent-specific.',
    evidence: { agentsSharingEndpoint: sharedWith + 1 },
  }
}

/**
 * Apply the rules in order and return the first that fires.
 *
 * Order matters: cheap static rules run before network rules, and D1 runs before
 * any success classification — otherwise an impostor scores as LIVE, which is the
 * exact mistake every naive crawler makes.
 */
export function classify(input: ClassifyInput): ProbeVerdict {
  const { services, samples, primaryBody } = input

  const none = declaredOnly(services)
  if (none) return none

  for (const svc of services) {
    const placeholder = d2_placeholderUrl(svc.endpoint)
    if (placeholder) return placeholder
    const notRemote = d3_notRemote(svc)
    if (notRemote) return notRemote
  }

  if (samples.length === 0) {
    return { state: 'UNPROBED', rule: '-', detail: 'Not yet probed.' }
  }

  const shared = d10_sharedEndpoint(input.sharedWithOtherAgents ?? 0)
  if (shared) return shared

  const impostor = d1_impostorStatic(samples)
  if (impostor) return impostor

  const primary = samples.find((s) => s.label === 'valid')
  if (!primary) return { state: 'UNPROBED', rule: '-', detail: 'No valid-id probe recorded.' }

  if (primary.error || primary.status === 0) {
    return {
      state: 'UNREACHABLE',
      rule: 'D0',
      detail: primary.error ?? 'No response from declared endpoint.',
    }
  }

  if (primary.status >= 400) {
    return {
      state: 'UNREACHABLE',
      rule: 'D0',
      detail: `Endpoint returned HTTP ${primary.status}.`,
      evidence: { status: primary.status },
    }
  }

  const handshake = d5_capabilityHandshake(primary, primaryBody ?? '')
  if (handshake) return handshake

  /**
   * CRITICAL: D1 needs at least two probes to mean anything. If the URL carried no
   * identifier we could vary, D1 never ran — and defaulting to LIVE there is exactly
   * the mistake D1 exists to prevent. Absence of evidence is not evidence of
   * liveness, so this reports as DEGRADED with the reason stated.
   */
  if (samples.length < 2) {
    return {
      state: 'DEGRADED',
      rule: 'D1-inapplicable',
      detail:
        'Responded with structured content, but the URL carries no identifier we ' +
        'could vary, so agent-specificity is unproven. Not counted as live.',
      evidence: { contentType: primary.contentType, probesRun: samples.length },
    }
  }

  return {
    state: 'LIVE',
    rule: 'D5',
    detail: 'Responded with structured content and is agent-specific.',
    evidence: { contentType: primary.contentType, latencyMs: primary.latencyMs },
  }
}

export { md5 }
