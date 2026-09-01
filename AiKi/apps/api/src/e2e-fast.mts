import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const API = 'https://api-production-02ce.up.railway.app'
const DOMAIN = 'www.useaiki.xyz'
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
console.log('as', account.address)

const ask = async (text: string) => {
  const turn = await call('/v1/assistant/messages', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  })
  const b = turn.body as {
    reply?: string
    steps?: { tool: string; ok: boolean }[]
    cost?: { points: number }
    error?: { message: string }
  }
  console.log(`\n> ${text}`)
  console.log('tools:', (b.steps ?? []).map((s) => `${s.tool}${s.ok ? '' : ' (refused)'}`).join(', ') || 'none')
  console.log('cost:', b.cost?.points ?? '-', 'points')
  console.log('reply:', (b.reply ?? b.error?.message ?? '').slice(0, 700))
}

await ask(
  'I need a human to check whether the team behind a BNB Chain project is real, by reading their ' +
    'GitHub and LinkedIn and telling me what they found. No agent can do that. Set up whatever ' +
    'you need and post it as paid work for 500 points.',
)
console.log('\n--- the board now ---')
const board = await call('/v1/tasks')
const tasks = (board.body as { tasks: { title: string; pricePoints: number; poster: string }[] }).tasks
for (const t of tasks.filter((t) => t.poster === account.address.toLowerCase()))
  console.log(`  ${t.pricePoints} points: ${t.title}`)
