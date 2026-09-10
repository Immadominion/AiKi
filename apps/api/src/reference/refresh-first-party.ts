/** Reviewed, exact-four report-only refresh. No signing, task dispatch or funding. */
import { hasCurrentLiveness } from '@aiki/contracts'
import { BSC_MAINNET } from '../config/chains.js'
import { assertPublicHost } from '../net/guard.js'
import type { VerificationInput } from '../prober/evidence-sink.js'
import { probeAgent } from '../prober/probe.js'
import { resolveRegistration } from '../prober/registration.js'
import { REFERENCE_REGISTRY } from './manifest.js'

const origin = 'https://www.useaiki.xyz'
export const FIRST_PARTY_REPORT_OWNER = '0x3a637bc6eb7c70479954c1f2d18cc959e90fb9b4'
export const FIRST_PARTY_REPORT_REFRESH = [
  { agentId: '315943', path: '/v1/reference/venus' },
  { agentId: '315944', path: '/v1/reference/pancake/rebalancer' },
  { agentId: '315945', path: '/v1/reference/pancake/grid' },
  { agentId: '315946', path: '/v1/reference/yield' },
] as const

const reviewedUrls = new Set([
  `${origin}/.well-known/agent-registration.json`,
  ...FIRST_PARTY_REPORT_REFRESH.flatMap((target) => [
    `${origin}${target.path}/manifest.json`,
    ...[target.agentId, '999999999', 'abc'].map((id) => `${origin}${target.path}/agent/${id}`),
  ]),
])

/** No redirect may expand the reviewed GET-only first-party destination set. */
export async function firstPartyReportFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input)
  if (!reviewedUrls.has(url.toString()) || (init.method ?? 'GET').toUpperCase() !== 'GET')
    throw new Error('Report refresh destination or method is not reviewed.')
  await assertPublicHost(url)
  return fetch(url, { ...init, method: 'GET', redirect: 'error' })
}

export interface FirstPartyRefreshReader {
  chainId(): Promise<number>
  /** Must read ownerOf and tokenURI at one verified finalized BSC block. */
  identity(agentId: string): Promise<{ owner: string; uri: string }>
}

/** Collect and verify all four before any caller is permitted to persist results. */
export async function prepareFirstPartyReportRefresh(
  reader: FirstPartyRefreshReader,
  dependencies: { resolve?: typeof resolveRegistration; probe?: typeof probeAgent } = {},
): Promise<VerificationInput[]> {
  const resolve =
    dependencies.resolve ??
    ((uri: string) => resolveRegistration(uri, undefined, firstPartyReportFetch))
  const probe =
    dependencies.probe ?? ((input) => probeAgent({ ...input, read: firstPartyReportFetch }))
  const results: VerificationInput[] = []
  if ((await reader.chainId()) !== 56) throw new Error('Report refresh requires BSC mainnet.')
  for (const target of FIRST_PARTY_REPORT_REFRESH) {
    const uri = `${origin}${target.path}/manifest.json`
    const endpoint = `${origin}${target.path}/agent/${target.agentId}`
    const before = await reader.identity(target.agentId)
    if (before.owner.toLowerCase() !== FIRST_PARTY_REPORT_OWNER || before.uri !== uri)
      throw new Error(`Report ${target.agentId} has changed its reviewed onchain identity.`)
    const registration = await resolve(uri)
    const manifest = registration.manifest
    if (
      registration.uri !== uri ||
      registration.status !== 'resolved' ||
      registration.scheme !== 'https' ||
      registration.zeroCost ||
      !manifest ||
      manifest.active === false ||
      manifest.services.length !== 1 ||
      manifest.services[0]?.endpoint !== endpoint ||
      !manifest.registrations.some(
        (claim) =>
          claim.agentId === target.agentId &&
          claim.agentRegistry?.toLowerCase() === REFERENCE_REGISTRY.toLowerCase(),
      )
    )
      throw new Error(`Report ${target.agentId} registration does not match its reviewed service.`)
    const result = await probe({
      agentId: target.agentId,
      registry: REFERENCE_REGISTRY,
      services: manifest.services,
      agentUri: uri,
    })
    if (
      result.agentId !== target.agentId ||
      result.registrationWasZeroCost ||
      result.reciprocal?.verified !== true ||
      !hasCurrentLiveness({ liveness: result.verdict.state, lastProbeAt: result.probedAt })
    )
      throw new Error(`Report ${target.agentId} did not produce a current LIVE reciprocal probe.`)
    const after = await reader.identity(target.agentId)
    if (after.uri !== before.uri || after.owner.toLowerCase() !== before.owner.toLowerCase())
      throw new Error(`Report ${target.agentId} identity changed during verification.`)
    results.push({
      chainId: 56,
      registry: BSC_MAINNET.contracts.erc8004Identity,
      agentId: target.agentId,
      registration,
      probe: result,
      identityVerified: true,
    })
  }
  if ((await reader.chainId()) !== 56) throw new Error('Report refresh network changed.')
  return results
}
