import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import type { JobService } from '../jobs/service.js'
import { registerTaskRoutes } from './routes.js'
import type { TaskRecord, TaskStore } from './store.js'

const poster = `0x${'ab'.repeat(20)}`
const worker = `0x${'cd'.repeat(20)}`
const stranger = `0x${'ef'.repeat(20)}`
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
function harness(changes: Partial<TaskRecord> = {}) {
  const task = {
    id: 'private-task',
    poster,
    claimedBy: worker,
    status: 'CLAIMED',
    directHire: true,
    title: 'Private commission',
    brief: 'A private work brief.',
    outlay: 512n,
    claimExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...changes,
  } as TaskRecord
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    const address = request.headers['test-signed-wallet']
    if (typeof address === 'string') request.session = { address, chainId: 97, exp: 9_999_999_999 }
  })
  registerTaskRoutes(app, {
    tasks: { get: async (id: string) => (id === task.id ? task : null) } as TaskStore,
    jobs: {} as JobService,
  })
  apps.push(app)
  return {
    task,
    read: (address?: string, expectedWallet?: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/tasks/${task.id}`,
        headers: {
          ...(address ? { 'test-signed-wallet': address } : {}),
          ...(expectedWallet ? { 'x-aiki-wallet-address': expectedWallet } : {}),
        },
      }),
  }
}

it('keeps direct human and assigned agent task briefs private from guests and other wallets', async () => {
  for (const changes of [
    {},
    { assignedAgentId: '315943' },
    { status: 'OPEN' as const, assignedAgentId: '315943', directHire: false },
  ]) {
    const { read } = harness(changes)
    expect((await read()).statusCode).toBe(404)
    const rejected = await read(stranger)
    expect(rejected.statusCode).toBe(404)
    expect(rejected.body).not.toContain('private work brief')
  }
})

it('lets only the poster and actual claimant read a direct task, case insensitively', async () => {
  const { read } = harness()
  for (const address of [poster, worker, poster.toUpperCase(), worker.toUpperCase()]) {
    const response = await read(address)
    expect(response.statusCode).toBe(200)
    expect(response.json().brief).toBe('A private work brief.')
  }
  expect((await read(poster, stranger)).statusCode).toBe(401)
})

it.each(['SUBMITTED', 'SETTLED', 'CANCELLED', 'DISPUTED'] as const)(
  'restricts %s work and its delivery to participants even if originally public',
  async (status) => {
    const { read } = harness({ status, directHire: false, submission: 'Private finished work.' })
    expect((await read()).statusCode).toBe(404)
    expect((await read(stranger)).statusCode).toBe(404)
    expect((await read(poster)).statusCode).toBe(200)
    expect((await read(worker)).statusCode).toBe(200)
  },
)

it('keeps genuinely open work public and allows expired public claims to be discovered again', async () => {
  const { read } = harness({ status: 'OPEN', directHire: false })
  expect((await read()).statusCode).toBe(200)
  const expired = harness({
    status: 'CLAIMED',
    directHire: false,
    claimExpiresAt: '2020-01-01T00:00:00Z',
  })
  expect((await expired.read()).statusCode).toBe(200)
  const directExpired = harness({
    status: 'CLAIMED',
    directHire: true,
    claimExpiresAt: '2020-01-01T00:00:00Z',
  })
  expect((await directExpired.read()).statusCode).toBe(404)
})
