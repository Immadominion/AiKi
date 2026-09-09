import { expect, it, vi } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET } from './enforcers.js'
import { executionNetwork, parseMainnetDeployment } from './execution-network.js'

// Configuration fixture only. These are not asserted mainnet deployments.
const mainnet = () => ({
  ...AIKI_ENFORCERS_BSC_TESTNET,
  chainId: 56,
  network: 'mainnet',
  managerCodeHash: `0x${'aa'.repeat(32)}`,
  registryCodeHash: `0x${'bb'.repeat(32)}`,
})

it('loads an explicit mainnet deployment without borrowing testnet contracts as a fallback', async () => {
  const load = vi.fn(async () => JSON.stringify(mainnet()))
  const network = await executionNetwork(
    {
      AIKI_EXECUTION_CHAIN_ID: '56',
      AIKI_ENFORCER_DEPLOYMENT_FILE: '/reviewed/deployment.json',
      BSC_RPC_URL: 'https://bsc.example',
    },
    load,
  )
  expect(network.deployment.chainId).toBe(56)
  expect(network.deployment.network).toBe('mainnet')
  expect(network.rpcUrl).toBe('https://bsc.example')
  expect(load).toHaveBeenCalledWith('/reviewed/deployment.json')
  expect(network.deployment).not.toBe(AIKI_ENFORCERS_BSC_TESTNET)
})

it('refuses mainnet without a reviewed file and never reads an implicit file', async () => {
  const load = vi.fn()
  await expect(executionNetwork({ AIKI_EXECUTION_CHAIN_ID: '56' }, load)).rejects.toThrow(
    'AIKI_ENFORCER_DEPLOYMENT_FILE',
  )
  expect(load).not.toHaveBeenCalled()
})

it('rejects a testnet manifest even when the operator selected mainnet', async () => {
  await expect(
    executionNetwork(
      { AIKI_EXECUTION_CHAIN_ID: '56', AIKI_ENFORCER_DEPLOYMENT_FILE: '/reviewed/file' },
      async () => JSON.stringify(AIKI_ENFORCERS_BSC_TESTNET),
    ),
  ).rejects.toThrow('chain56')
})

it('requires pins for manager, registry and each distinct required enforcer', () => {
  const valid = mainnet()
  expect(parseMainnetDeployment(valid).audited).toBe(false)
  for (const data of [
    { ...valid, managerCodeHash: undefined },
    { ...valid, registryCodeHash: '0x' },
    { ...valid, manager: `0x${'00'.repeat(20)}` },
    { ...valid, registry: valid.manager },
    { ...valid, enforcers: valid.enforcers.slice(1) },
    { ...valid, enforcers: Array(6).fill(valid.enforcers[0]) },
    { ...valid, audited: 'yes' },
  ])
    expect(() => parseMainnetDeployment(data)).toThrow()
})

it('keeps network selection explicit, bounded, and compatible with existing testnet installs', async () => {
  expect((await executionNetwork({})).deployment).toBe(AIKI_ENFORCERS_BSC_TESTNET)
  expect((await executionNetwork({ AIKI_EXECUTION_CHAIN_ID: '97' })).deployment.chainId).toBe(97)
  await expect(executionNetwork({ AIKI_EXECUTION_CHAIN_ID: '1' })).rejects.toThrow()
  await expect(executionNetwork({ AIKI_EXECUTION_CHAIN_ID: '56junk' })).rejects.toThrow()
})
