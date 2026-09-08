import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settlementForPoints } from '../credits/pricing.js'
import {
  DuplicateCharge,
  ESCROW_ACCOUNT,
  InMemoryCreditStore,
  PostgresCreditStore,
} from '../credits/store.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { SETTLEMENT } from '../settlement/pricing.js'
import { registerTaskRoutes } from './routes.js'
import { PostgresTaskStore } from './store.js'
import type { AgentTaskContact } from './support.js'

const fetched = vi.fn()
vi.mock('../net/guard.js', () => ({ guardedFetch: (...args: unknown[]) => fetched(...args) }))

describe.skipIf(!process.env.DATABASE_URL)(
  'agent task hiring over HTTP with persistent retries',
  () => {
    const cleanup: Array<() => Promise<unknown>> = []
    beforeEach(() => {
      fetched.mockReset()
      fetched.mockImplementation(
        async () =>
          new Response(JSON.stringify({ result: 'No Venus debt was found.' }), {
            headers: { 'content-type': 'application/json' },
          }),
      )
    })
    afterEach(async () => {
      await Promise.all(cleanup.splice(0).map((close) => close()))
    })

    async function harness(
      options: {
        contact?: Partial<AgentTaskContact>
        configured?: boolean
        balance?: number
        postgresCredits?: boolean
      } = {},
    ) {
      const owner = `0x${randomUUID().replaceAll('-', '')}12345678`
      const seller = `0x${'ab'.repeat(20)}`
      const tasks = new PostgresTaskStore(process.env.DATABASE_URL as string)
      const jobStore = new PostgresJobStore(process.env.DATABASE_URL as string)
      const jobs = new JobService(jobStore)
      const credits = options.postgresCredits
        ? new PostgresCreditStore(process.env.DATABASE_URL as string)
        : new InMemoryCreditStore()
      if (credits instanceof PostgresCreditStore) cleanup.push(() => credits.close())
      await credits.deposit({
        owner,
        points: options.balance ?? 5_000,
        reason: 'test',
        reference: randomUUID(),
      })
      const authorization = await jobs.authorize(
        [
          {
            kind: 'asset_scope',
            value: [SETTLEMENT.address],
            tier: 'T2',
            label: 'Settlement asset',
          },
          {
            kind: 'session_total_cap',
            value: settlementForPoints(1_000, SETTLEMENT.decimals).toString(),
            tier: 'T2',
            label: 'Task budget',
          },
        ],
        owner,
      )
      const app = Fastify()
      app.addHook('onRequest', async (request) => {
        request.session = { address: owner, chainId: 56, exp: Math.floor(Date.now() / 1_000) + 600 }
      })
      registerTaskRoutes(app, {
        tasks,
        jobs,
        credits,
        settlementTreasury: `0x${'cd'.repeat(20)}`,
        ...(options.configured === false
          ? {}
          : { publicUrl: 'https://api.example', deliverySecret: 'test-delivery-secret' }),
        agentContact: async () => ({
          owner: seller,
          endpoint: 'https://agent.example/task',
          live: true,
          compatible: true,
          ...options.contact,
        }),
      })
      cleanup.push(
        () => app.close(),
        () => tasks.close(),
        () => jobStore.close(),
      )
      const payload = {
        title: 'Read my Venus position',
        brief: `Read ${owner}, without moving anything.`,
        kind: 'research',
        pricePoints: 500,
        workHours: 1,
        assignAgentId: '315943',
        authorizationId: authorization.id,
      }
      const request = (key = 'one-hire', body: Record<string, unknown> = payload) =>
        app.inject({
          method: 'POST',
          url: '/v1/tasks',
          headers: { 'idempotency-key': key },
          payload: body,
        })
      return { app, tasks, jobs, credits, owner, seller, authorization, payload, request }
    }

    it('replays one actual task without repeating the cap, funding or agent dispatch', async () => {
      const h = await harness()
      const first = await h.request()
      const second = await h.request()
      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
      expect(second.headers['idempotency-replayed']).toBe('true')
      expect(second.json()).toEqual(first.json())
      expect(first.json()).toMatchObject({
        status: 'SUBMITTED',
        heldPoints: 512,
        pricePoints: 500,
        feePoints: 12,
        submission: 'No Venus debt was found.',
      })
      expect(await h.tasks.mine(h.owner)).toHaveLength(1)
      expect(await h.credits.balance(h.owner)).toBe(4_488)
      expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(
        settlementForPoints(512, SETTLEMENT.decimals),
      )
      expect(fetched).toHaveBeenCalledTimes(1)
      const changed = await h.request('one-hire', { ...h.payload, pricePoints: 600 })
      expect(changed.statusCode).toBe(409)
      expect(changed.json().error.code).toBe('TASK_IDEMPOTENCY_CONFLICT')
      expect(fetched).toHaveBeenCalledTimes(1)
    })

    it('refuses a concurrent retry while the original agent call is pending, then replays its result', async () => {
      let entered: () => void = () => {}
      let release: () => void = () => {}
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      fetched.mockImplementation(async () => {
        entered()
        await pending
        return new Response(JSON.stringify({ result: 'Finished once.' }), {
          headers: { 'content-type': 'application/json' },
        })
      })
      const h = await harness()
      const original = h.request().then((response) => response)
      await started
      const duplicate = await h.request()
      expect(duplicate.statusCode).toBe(409)
      expect(duplicate.json().error.code).toBe('TASK_REQUEST_IN_PROGRESS')
      release()
      const completed = await original
      expect((await h.request()).json().id).toBe(completed.json().id)
      expect(fetched).toHaveBeenCalledTimes(1)
      expect(await h.credits.balance(h.owner)).toBe(4_488)
    })

    it('blocks unavailable, incompatible and unconfigured agents before reserving money or caps', async () => {
      for (const options of [
        { contact: { live: false } },
        { contact: { compatible: false } },
        { configured: false },
      ]) {
        const h = await harness(options)
        const support = await h.app.inject({ method: 'GET', url: '/v1/agents/315943/task-support' })
        expect(support.json()).toMatchObject({
          available: false,
          minimumPricePoints: 10,
          feeBasisPoints: 250,
        })
        const result = await h.request()
        expect([422, 503]).toContain(result.statusCode)
        expect(await h.credits.balance(h.owner)).toBe(5_000)
        expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(0n)
        expect(await h.tasks.mine(h.owner)).toHaveLength(0)
      }
      expect(fetched).not.toHaveBeenCalled()
    })

    it('cancels an assigned task that could not be funded and restores its cap', async () => {
      const h = await harness({ balance: 10 })
      const result = await h.request()
      expect(result.statusCode).toBe(402)
      expect((await h.tasks.mine(h.owner))[0]?.status).toBe('CANCELLED')
      expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(0n)
      expect(await h.credits.balance(h.owner)).toBe(10)
      expect(fetched).not.toHaveBeenCalled()
    })

    it('rejects malformed prices and durations without reserving a spending cap', async () => {
      const h = await harness()
      for (const change of [
        { pricePoints: Number.MAX_SAFE_INTEGER + 1 },
        { pricePoints: Number.MAX_SAFE_INTEGER },
        { pricePoints: 500.5 },
        { workHours: 'not a number' },
        { workHours: 'Infinity' },
        { workHours: {} },
      ]) {
        const result = await h.request(randomUUID(), { ...h.payload, ...change })
        expect(result.statusCode).toBe(400)
        expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(0n)
        expect(await h.credits.balance(h.owner)).toBe(5_000)
        expect(await h.tasks.mine(h.owner)).toHaveLength(0)
      }
      expect(fetched).not.toHaveBeenCalled()
    })

    it('releases the reserved cap when task persistence fails before funding', async () => {
      const h = await harness()
      const create = vi
        .spyOn(h.tasks, 'create')
        .mockRejectedValueOnce(new Error('Database unavailable'))
      try {
        const result = await h.request()
        expect(result.statusCode).toBe(500)
        expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(0n)
        expect(await h.credits.balance(h.owner)).toBe(5_000)
        expect(await h.tasks.mine(h.owner)).toHaveLength(0)
        expect(fetched).not.toHaveBeenCalled()
      } finally {
        create.mockRestore()
      }
    })

    it.each(['lost acknowledgement', 'duplicate reference'])(
      'reconciles committed PostgreSQL funding after a %s without cancelling or charging twice',
      async (failure) => {
        const h = await harness({ postgresCredits: true })
        const transfer = h.credits.transfer.bind(h.credits)
        const mocked = vi.spyOn(h.credits, 'transfer').mockImplementationOnce(async (input) => {
          await transfer(input)
          if (failure === 'duplicate reference') throw new DuplicateCharge(input.reference)
          throw new Error('Commit acknowledgement lost')
        })
        try {
          const first = await h.request()
          expect(first.statusCode).toBe(201)
          expect(first.json().status).toBe('SUBMITTED')
          expect((await h.request()).json()).toEqual(first.json())
          expect(await h.credits.balance(h.owner)).toBe(4_488)
          expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(
            settlementForPoints(512, SETTLEMENT.decimals),
          )
          expect(mocked).toHaveBeenCalledTimes(1)
          expect(fetched).toHaveBeenCalledTimes(1)
        } finally {
          mocked.mockRestore()
        }
      },
    )

    it('keeps uncertain funding and the cap recoverable without dispatch or another charge', async () => {
      const h = await harness({ postgresCredits: true })
      const transfer = h.credits.transfer.bind(h.credits)
      const mocked = vi.spyOn(h.credits, 'transfer').mockImplementationOnce(async (input) => {
        await transfer(input)
        throw new Error('Commit acknowledgement lost')
      })
      const lookup = vi
        .spyOn(h.credits, 'transferRecorded')
        .mockRejectedValueOnce(new Error('Read unavailable'))
      try {
        const first = await h.request()
        expect(first.statusCode).toBe(503)
        expect(first.json().error.code).toBe('TASK_FUNDING_UNCONFIRMED')
        const task = (await h.tasks.mine(h.owner))[0]
        expect(task?.status).toBe('CLAIMED')
        expect(task?.dispatchedAt).toBeUndefined()
        expect(task?.dispatchNote).toContain('Payment confirmation is pending')
        expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(
          settlementForPoints(512, SETTLEMENT.decimals),
        )
        expect(await h.credits.balance(h.owner)).toBe(4_488)
        expect((await h.request()).json()).toEqual(first.json())
        expect(mocked).toHaveBeenCalledTimes(1)
        expect(fetched).not.toHaveBeenCalled()
      } finally {
        mocked.mockRestore()
        lookup.mockRestore()
      }
    })

    it('fails closed before payout when the funding lookup itself is unavailable', async () => {
      const h = await harness({ postgresCredits: true })
      const first = await h.request()
      expect(first.statusCode).toBe(201)
      const taskId = first.json().id
      const escrowBefore = await h.credits.balance(ESCROW_ACCOUNT)
      const lookup = vi
        .spyOn(h.credits, 'transferRecorded')
        .mockRejectedValue(new Error('Read unavailable'))
      try {
        for (const action of ['accept', 'release', 'cancel']) {
          const result = await h.app.inject({
            method: 'POST',
            url: `/v1/tasks/${taskId}/${action}`,
          })
          expect(result.statusCode).toBe(503)
          expect(result.json().error.code).toBe('TASK_FUNDING_UNCONFIRMED')
        }
        expect((await h.tasks.get(taskId))?.status).toBe('SUBMITTED')
        expect(await h.credits.balance(ESCROW_ACCOUNT)).toBe(escrowBefore)
        expect(await h.credits.balance(h.owner)).toBe(4_488)
      } finally {
        lookup.mockRestore()
      }
    })

    it("never pays or refunds an unfunded task from another task's shared escrow", async () => {
      const h = await harness({ postgresCredits: true })
      const mocked = vi
        .spyOn(h.credits, 'transfer')
        .mockRejectedValueOnce(new Error('Transfer unavailable'))
      const result = await h.request()
      mocked.mockRestore()
      expect(result.statusCode).toBe(503)
      const task = (await h.tasks.mine(h.owner))[0]
      if (!task) throw new Error('Expected preserved task')
      // Escrow can have other buyers' money. This is not proof of our funding.
      await h.credits.deposit({
        owner: ESCROW_ACCOUNT,
        points: 2_000,
        reason: 'other funding',
        reference: randomUUID(),
      })
      const escrowBefore = await h.credits.balance(ESCROW_ACCOUNT)
      await h.tasks.recordDelivery(task.id, '315943', 'Work without a confirmed payment')
      for (const action of ['accept', 'release', 'cancel']) {
        const response = await h.app.inject({
          method: 'POST',
          url: `/v1/tasks/${task.id}/${action}`,
        })
        expect(response.statusCode).toBe(503)
        expect(response.json().error.code).toBe('TASK_FUNDING_UNCONFIRMED')
      }
      expect(await h.credits.balance(ESCROW_ACCOUNT)).toBe(escrowBefore)
      expect(await h.credits.balance(h.owner)).toBe(5_000)
      expect((await h.tasks.get(task.id))?.status).toBe('SUBMITTED')
      expect((await h.jobs.getAuthorization(h.authorization.id)).spent).toBe(
        settlementForPoints(512, SETTLEMENT.decimals),
      )
      expect(fetched).not.toHaveBeenCalled()
    })
  },
)
