// biome-ignore-all lint/style/noNonNullAssertion: fixture creates exactly one named action; tests deliberately mutate it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardianFor } from '@aiki/contracts/guardian'
import { WalletTransactionError } from '../../lib/wallet'
import {
  createTransactionJournal,
  sendStrategyAction,
  signStrategyAuthorization,
  startStrategySetup,
} from './controller'
import {
  addressAt,
  authorizationFixture,
  config,
  controllerFixture,
  owner,
  transactionHash,
} from './test-support'

test('one reviewed funding call is submitted and only a finalized response clears recovery', async () => {
  const { state, deps } = controllerFixture()
  const result = await sendStrategyAction(state.setup, config, state.setup.actions[0]!, deps)
  assert.equal(result.actions[0]?.status, 'FINALIZED')
  assert.deepEqual([state.sends, state.submits, state.finalizes], [1, 1, 1])
  assert.equal(deps.journal.get(owner, state.setup.id, 'action-1'), null)
})
test('a definite decline retries the same action; lost acknowledgement never opens a second popup', async () => {
  for (const declined of [true, false]) {
    const { state, deps } = controllerFixture()
    deps.send = async () => {
      state.sends++
      throw new WalletTransactionError(declined ? 4001 : 'SUBMISSION_UNKNOWN', 'fixture', !declined)
    }
    const send = () => sendStrategyAction(state.setup, config, state.setup.actions[0]!, deps)
    await assert.rejects(send())
    await assert.rejects(send())
    assert.equal(state.sends, declined ? 2 : 1)
    assert.equal(state.submits, 0)
    assert.equal(!!deps.journal.get(owner, state.setup.id, 'action-1'), !declined)
  }
})
test('lost submit acknowledgement is retried by exact hash without repeating the wallet transaction', async () => {
  const { state, deps } = controllerFixture(),
    submit = deps.api.submitAction
  deps.api.submitAction = async (...args) => {
    await submit(...args)
    throw new Error('Lost response')
  }
  await assert.rejects(sendStrategyAction(state.setup, config, state.setup.actions[0]!, deps))
  deps.api.submitAction = submit
  await sendStrategyAction(state.setup, config, state.setup.actions[0]!, deps)
  assert.equal(state.sends, 1)
  assert.equal(state.setup.actions[0]?.transactionHash, transactionHash)
  assert.equal(state.setup.actions[0]?.status, 'FINALIZED')
})
test('wallet changes preserve returned hash but prevent private API mutations', async () => {
  const { state, deps } = controllerFixture()
  deps.send = async () => {
    state.sends++
    state.wallet = addressAt('fe')
    state.revision++
    return { transactionHash, walletCurrent: false }
  }
  await assert.rejects(
    sendStrategyAction(state.setup, config, state.setup.actions[0]!, deps),
    /changed/,
  )
  assert.equal(state.submits, 0)
  assert.equal(
    deps.journal.get(owner, state.setup.id, 'action-1')?.transactionHash,
    transactionHash,
  )
})
test('concurrent send handlers cannot both pass the pre-popup journal lock', async () => {
  const { state, deps } = controllerFixture()
  const action = state.setup.actions[0]!
  await Promise.allSettled([
    sendStrategyAction(state.setup, config, action, deps),
    sendStrategyAction(state.setup, config, action, deps),
  ])
  assert.equal(state.sends, 1)
})
test('missing persistence, changed manager or changed mandate account fail before wallet writes', async () => {
  for (const reason of ['storage', 'manager', 'account']) {
    const { state, deps } = controllerFixture()
    if (reason === 'storage')
      deps.journal = createTransactionJournal(() => {
        throw new Error('No storage')
      })
    if (reason === 'manager') state.config.manager = addressAt('fe')
    if (reason === 'account')
      deps.account = async () => ({ address: addressAt('fe'), chainId: 56, network: 'mainnet' })
    await assert.rejects(sendStrategyAction(state.setup, config, state.setup.actions[0]!, deps))
    assert.equal(state.sends, 0)
  }
})
test('concurrent start and acknowledgement retries use the same active setup without a second start', async () => {
  const { state, deps } = controllerFixture()
  state.setup.authorization = {
    id: 'auth',
    jobId: 'job',
    watchId: 'watch',
    signedAt: '2026-09-10',
    review: {} as never,
  }
  state.setup.readiness.ready = true
  const before = structuredClone(state.setup)
  await Promise.all([
    startStrategySetup(before, config, deps),
    startStrategySetup(before, config, deps),
  ])
  await startStrategySetup(before, config, deps)
  assert.equal(state.starts, 1)
})
test('start is refused without separately verified signature, funding and scheduler readiness', async () => {
  const { state, deps } = controllerFixture()
  await assert.rejects(startStrategySetup(state.setup, config, deps), /Funding/)
  assert.equal(state.starts, 0)
})

test('declined mandate and changed wallet or grant while signing never file or start anything', async () => {
  for (const reason of ['declined', 'wallet', 'grant']) {
    const { state, deps } = controllerFixture(),
      prep = authorizationFixture(state.setup)
    let signatures = 0,
      files = 0,
      changed = false
    deps.network = async () => ({
      configured: true,
      chainId: 56,
      network: 'mainnet',
      audited: true,
      manager: config.manager,
      guardian: guardianFor(56),
    })
    deps.api.prepareAuthorization = async () =>
      changed ? { ...prep, digest: transactionHash } : prep
    deps.api.fileAuthorization = async () => {
      files++
      return state.setup
    }
    deps.sign = async () => {
      signatures++
      if (reason === 'declined') throw new Error('User declined')
      if (reason === 'wallet') {
        state.wallet = addressAt('fe')
        state.revision++
      }
      if (reason === 'grant') changed = true
      return { ...prep.unsigned, signature: '0x1234' }
    }
    await assert.rejects(signStrategyAuthorization(state.setup, config, prep, deps))
    assert.equal(signatures, 1)
    assert.equal(files, 0)
    assert.equal(state.starts, 0)
  }
})

test('lost signature filing acknowledgement resumes same signed grant without another signature', async () => {
  const { state, deps } = controllerFixture(),
    prep = authorizationFixture(state.setup)
  let signatures = 0,
    files = 0
  deps.network = async () => ({
    configured: true,
    chainId: 56,
    network: 'mainnet',
    audited: true,
    manager: config.manager,
    guardian: guardianFor(56),
  })
  deps.api.prepareAuthorization = async () => prep
  deps.sign = async () => {
    signatures++
    return { ...prep.unsigned, signature: '0x1234' }
  }
  deps.api.fileAuthorization = async () => {
    files++
    state.setup.authorization = {
      id: 'auth',
      jobId: 'job',
      watchId: 'watch',
      signedAt: '2026-09-10',
      review: prep.review,
      digest: prep.digest,
    }
    throw new Error('Lost file acknowledgement')
  }
  const before = structuredClone(state.setup)
  await assert.rejects(signStrategyAuthorization(before, config, prep, deps))
  const recovered = await signStrategyAuthorization(before, config, prep, deps)
  assert.equal(recovered.authorization?.digest, prep.digest)
  assert.deepEqual([signatures, files, state.starts], [1, 1, 0])
})

test('a session or configuration change during shared signing preflight prevents the late wallet prompt', async () => {
  for (const reason of ['session', 'configuration']) {
    const { state, deps } = controllerFixture(),
      prep = authorizationFixture(state.setup)
    let prompts = 0
    deps.network = async () => ({
      configured: true,
      chainId: 56,
      network: 'mainnet',
      audited: true,
      manager: config.manager,
      guardian: guardianFor(56),
    })
    deps.api.prepareAuthorization = async () => prep
    deps.signWallet = async () => {
      prompts++
      return 'declined'
    }
    deps.sign = async (_prepared, _network, _account, _owner, guards) => {
      await Promise.resolve()
      if (reason === 'session') state.revision++
      else state.config.executor = addressAt('fe')
      assert.ok(guards?.sign)
      await guards.sign(owner, {
        domain: prep.domain,
        types: prep.types,
        primaryType: prep.primaryType,
        message: prep.message,
      })
      throw new Error('The invalidated review must never reach the wallet')
    }
    await assert.rejects(signStrategyAuthorization(state.setup, config, prep, deps), /changed/)
    assert.equal(prompts, 0)
  }
})
