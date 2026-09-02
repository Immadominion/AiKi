import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const API = 'https://api-production-02ce.up.railway.app'
const DOMAIN = 'www.useaiki.xyz'
const U = '0xcE24439F2D9C6a2289F741120FE202248B666666'
const account = privateKeyToAccount(generatePrivateKey())
let cookie = ''

const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0] as string
  const raw = await res.text()
  try {
    return { status: res.status, body: JSON.parse(raw) as Record<string, unknown> }
  } catch {
    return { status: res.status, body: { raw } as Record<string, unknown> }
  }
}

const nonce = await call('/v1/auth/nonce', { method: 'POST' })
const message = createSiweMessage({
  address: account.address,
  chainId: 56,
  domain: DOMAIN,
  nonce: (nonce.body as { nonce: string }).nonce,
  uri: `https://${DOMAIN}`,
  version: '1',
})
await call('/v1/auth/verify', {
  method: 'POST',
  body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
})
await call('/v1/credits')

const mandate = await call('/v1/authorizations', {
  method: 'POST',
  body: JSON.stringify({
    constraints: [
      { kind: 'asset_scope', value: [U], tier: 'T2', label: 'Only U' },
      { kind: 'session_total_cap', value: '1000000000000000000', tier: 'T2', label: '1 U' },
      { kind: 'expiry', value: '2026-12-01T00:00:00.000Z', tier: 'T2', label: 'Expires' },
    ],
  }),
})
const mandateId = (mandate.body as { id: string }).id

// 310366 declares https://evoevo.ai/agent/detail?id=... which is a web page,
// so this is the common case: an agent that will not speak the protocol.
for (const agentId of ['310366', '315943']) {
  const hired = await call('/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Say what this position is worth',
      brief: 'Price it and show your working.',
      kind: 'research',
      pricePoints: 300,
      workHours: 6,
      authorizationId: mandateId,
      assignAgentId: agentId,
    }),
  })
  const b = hired.body as {
    id?: string
    status?: string
    dispatchNote?: string
    error?: { message: string }
  }
  console.log(`\nagent ${agentId}: ${hired.status}`)
  console.log('  status:', b.status ?? '-')
  console.log('  what happened when we called:', b.dispatchNote ?? b.error?.message ?? '-')
  if (b.id) {
    const back = await call(`/v1/tasks/${b.id}/cancel`, { method: 'POST' })
    console.log(
      '  cancel while it still has time:',
      back.status,
      (back.body as { error?: { message: string } }).error?.message ?? 'refunded',
    )
  }
}
console.log('\nbalance:', JSON.stringify((await call('/v1/credits')).body).slice(0, 90))
console.log('books:', JSON.stringify((await call('/v1/ledger/health')).body).slice(0, 60))
