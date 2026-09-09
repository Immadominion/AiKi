import { createPublicClient, erc20Abi, http, type PublicClient, type Transport } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'
import type { DepositConfig } from '../credits/deposit.js'
import { ClientError } from '../http/errors.js'

const MAINNET_USDT = '0x55d398326f99059ff775485246999027b3197955'
const TESTNET_USDT = '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const validAddress = (value: string) => ADDRESS.test(value) && !/^0x0{40}$/.test(value)

/** Credits have their own network selection, independent of account execution. */
export function creditsNetwork(env: Record<string, string | undefined>): DepositConfig | undefined {
  const treasury = env.CREDITS_TREASURY_ADDRESS
  if (!treasury) return undefined
  const selected = env.CREDITS_CHAIN_ID ?? '97'
  if (selected !== '56' && selected !== '97') throw new Error('CREDITS_CHAIN_ID must be 56 or 97.')
  if (!validAddress(treasury))
    throw new Error('CREDITS_TREASURY_ADDRESS must be a nonzero address.')
  const chainId = selected === '56' ? 56 : 97
  const token = env.CREDITS_TOKEN_ADDRESS ?? (chainId === 56 ? MAINNET_USDT : TESTNET_USDT)
  if (!validAddress(token)) throw new Error('CREDITS_TOKEN_ADDRESS must be a nonzero address.')
  if (chainId === 56 && token.toLowerCase() !== MAINNET_USDT)
    throw new Error('Mainnet credits require the configured BSC USDT token.')
  const rpcUrl =
    env.CREDITS_RPC_URL ??
    (chainId === 56
      ? (env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org')
      : 'https://data-seed-prebsc-1-s1.bnbchain.org:8545')
  try {
    if (!['http:', 'https:'].includes(new URL(rpcUrl).protocol)) throw new Error()
  } catch {
    throw new Error('CREDITS_RPC_URL must be an HTTP or HTTPS URL.')
  }
  return {
    chainId,
    decimals: chainId === 56 ? 18 : 6,
    token: token as `0x${string}`,
    treasury: treasury as `0x${string}`,
    rpcUrl,
  }
}

/** No retries: each network read is bounded and callers retain the same payment hash. */
export function creditNetworkClient(
  config: DepositConfig,
): PublicClient<Transport, typeof bsc | typeof bscTestnet> {
  return createPublicClient({
    chain: config.chainId === 56 ? bsc : bscTestnet,
    transport: http(config.rpcUrl, { timeout: 5_000, retryCount: 0 }),
  })
}

/** Fresh marker read for payment instructions and each subsequent deposit claim. */
export async function readCreditFinalizedBlock(
  config: DepositConfig,
): Promise<{ number: bigint; hash: string }> {
  try {
    const finalized = await creditNetworkClient(config).getBlock({ blockTag: 'finalized' })
    if (
      !finalized ||
      typeof finalized.number !== 'bigint' ||
      finalized.number < 0n ||
      typeof finalized.hash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(finalized.hash) ||
      /^0x0{64}$/.test(finalized.hash)
    )
      throw new Error('The finalized block is unavailable.')
    return { number: finalized.number, hash: finalized.hash.toLowerCase() }
  } catch {
    throw new ClientError(
      'Payment finality could not be checked. Retry later before sending funds. If you already paid, retry the same transaction hash; do not send another payment.',
      { code: 'DEPOSIT_CONFIRMATIONS_UNAVAILABLE', statusCode: 503 },
    )
  }
}

/** Read-only verification before advertising a rail, crediting it, or counting its backing. */
export async function verifyCreditNetwork(config: DepositConfig): Promise<void> {
  if (
    ![56, 97].includes(config.chainId) ||
    config.decimals !== (config.chainId === 56 ? 18 : 6) ||
    !validAddress(config.token) ||
    !validAddress(config.treasury) ||
    (config.chainId === 56 && config.token.toLowerCase() !== MAINNET_USDT)
  )
    throw new ClientError(
      'The payment network configuration is invalid. Contact AiKi before sending funds.',
      {
        code: 'DEPOSIT_CONFIGURATION_INVALID',
        statusCode: 503,
      },
    )
  const client = creditNetworkClient(config)
  let chainId: number
  try {
    chainId = await client.getChainId()
  } catch {
    throw new ClientError(
      'The payment network could not be checked. Retry the same transaction hash later; do not send another payment.',
      {
        code: 'DEPOSIT_NETWORK_UNAVAILABLE',
        statusCode: 503,
      },
    )
  }
  if (chainId !== config.chainId)
    throw new ClientError(
      'The payment network does not match this deployment. No points were added. Contact AiKi before sending funds.',
      {
        code: 'DEPOSIT_NETWORK_MISMATCH',
        statusCode: 503,
      },
    )
  let decimals: number
  try {
    decimals = await client.readContract({
      address: config.token,
      abi: erc20Abi,
      functionName: 'decimals',
    })
  } catch {
    throw new ClientError(
      'The payment token could not be checked. Retry the same transaction hash later; do not send another payment.',
      {
        code: 'DEPOSIT_TOKEN_UNAVAILABLE',
        statusCode: 503,
      },
    )
  }
  if (decimals !== config.decimals)
    throw new ClientError(
      'The payment token decimals do not match this deployment. No points were added. Contact AiKi before sending funds.',
      {
        code: 'DEPOSIT_TOKEN_MISMATCH',
        statusCode: 503,
      },
    )
}
