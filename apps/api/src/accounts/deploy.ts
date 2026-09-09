import { randomUUID } from 'node:crypto'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ClientError } from '../http/errors.js'
import { type DeploymentAttempt, deploymentAddress } from './attempts.js'
import { MANDATE_ACCOUNT_BYTECODE } from './bytecode.js'
import { expectedAccountRuntime } from './runtime.js'
import type { AccountStore } from './store.js'

/**
 * Put one person's mandate account on chain.
 *
 * A mandate needs somewhere for the value to live, and that somewhere belongs to
 * exactly one person: the constructor takes their address as `owner` and the
 * manager as the account's only executor. Nobody can use this product until they
 * have one, and asking somebody to deploy a contract before they may try
 * anything is not an onboarding step, it is a wall.
 *
 * So AiKi pays the gas. That is not custody and it is worth being precise about
 * why: the key here signs a deployment and nothing else. It is not the owner, it
 * is not an executor, it holds no authority over the account afterwards, and the
 * worst it can do if it leaks is waste gas deploying accounts for strangers.
 * The account's owner is the person who asked for it, from the first block.
 */
export interface AccountDeployer {
  deploy(owner: Address): Promise<{ address: Address; transactionHash: Hex; created?: boolean }>
}

export function viemAccountDeployer(input: {
  rpcUrl: string
  chainId: number
  manager: Address
  /** Pays gas to deploy. Holds no authority over anything it deploys. */
  funderKey: Hex
  /** The same durable store used by the account route. Required before signing. */
  store: AccountStore
}): AccountDeployer {
  if (input.chainId !== 56 && input.chainId !== 97)
    throw new Error('Account deployment requires a supported BNB network.')
  const manager = deploymentAddress(input.manager)
  const chain = {
    id: input.chainId,
    name: `chain-${input.chainId}`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  } as const
  const transport = http(input.rpcUrl)
  const publicClient = createPublicClient({ chain, transport })
  const signingAccount = (() => {
    try {
      return privateKeyToAccount(input.funderKey)
    } catch {
      throw new Error('The account-deployment signing key is invalid.')
    }
  })()
  const wallet = createWalletClient({
    account: signingAccount,
    chain,
    transport,
  })
  const funder = deploymentAddress(signingAccount.address)
  const pending = (attempt?: DeploymentAttempt) =>
    new ClientError(
      `Account deployment is pending or needs review. Do not send another deployment.${attempt?.transactionHash ? ` Transaction: ${attempt.transactionHash}. Retry only to check this same transaction.` : ''}`,
      { statusCode: 409, code: 'ACCOUNT_DEPLOY_PENDING' },
    )
  const validHash = (value: unknown): value is Hex =>
    typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value)
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null

  async function complete(attempt: DeploymentAttempt, result: unknown) {
    const receipt = record(result)
    if (
      !attempt.transactionHash ||
      !attempt.expectedAddress ||
      !receipt ||
      !validHash(receipt.transactionHash) ||
      receipt.transactionHash.toLowerCase() !== attempt.transactionHash ||
      !validHash(receipt.blockHash) ||
      typeof receipt.blockNumber !== 'bigint' ||
      receipt.blockNumber < 0n ||
      (receipt.status !== 'success' && receipt.status !== 'reverted') ||
      (await publicClient.getChainId()) !== attempt.chainId
    )
      throw new Error('Deployment receipt identity is not verified.')
    const finalized = await publicClient.getBlock({ blockTag: 'finalized' })
    if (
      !finalized ||
      typeof finalized.number !== 'bigint' ||
      finalized.number < receipt.blockNumber ||
      !validHash(finalized.hash) ||
      (finalized.number === receipt.blockNumber &&
        finalized.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
    )
      throw new Error('Deployment is not finalized.')
    if (receipt.status === 'success') {
      if (
        typeof receipt.contractAddress !== 'string' ||
        receipt.contractAddress.toLowerCase() !== attempt.expectedAddress
      )
        throw new Error('Deployment contract address does not match the signed nonce.')
      const [code, actualOwner, actualManager] = await Promise.all([
        publicClient.getCode({ address: attempt.expectedAddress, blockNumber: finalized.number }),
        publicClient.readContract({
          address: attempt.expectedAddress,
          abi: parseAbi(['function owner() view returns (address)']),
          functionName: 'owner',
          blockNumber: finalized.number,
        }),
        publicClient.readContract({
          address: attempt.expectedAddress,
          abi: parseAbi(['function DELEGATION_MANAGER() view returns (address)']),
          functionName: 'DELEGATION_MANAGER',
          blockNumber: finalized.number,
        }),
      ])
      if (
        code?.toLowerCase() !== expectedAccountRuntime(attempt.manager).toLowerCase() ||
        typeof actualOwner !== 'string' ||
        actualOwner.toLowerCase() !== attempt.owner ||
        typeof actualManager !== 'string' ||
        actualManager.toLowerCase() !== attempt.manager
      )
        throw new Error('Deployment account ownership, manager or runtime is not verified.')
    }
    // Canonicality follows finality and account reads, not the other way round.
    const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
    if (
      !canonical ||
      canonical.number !== receipt.blockNumber ||
      !validHash(canonical.hash) ||
      canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      (await publicClient.getChainId()) !== attempt.chainId
    )
      throw new Error('Deployment is not canonical on its recorded chain.')
    if (receipt.status === 'reverted') {
      await input.store.finishDeployment(attempt.id, 'REVERTED')
      throw new ClientError(
        'The exact account deployment reverted and is finalized. No account was created.',
        { statusCode: 502, code: 'ACCOUNT_DEPLOY_REVERTED' },
      )
    }
    const account = await input.store.finalizeDeployment(attempt)
    return { address: account.address, transactionHash: account.deployedTx as Hex, created: true }
  }

  async function uncertain(attempt: DeploymentAttempt): Promise<never> {
    await input.store.finishDeployment(attempt.id, 'UNCONFIRMED').catch(() => {})
    throw pending(attempt)
  }

  return {
    async deploy(owner) {
      owner = deploymentAddress(owner)
      const existing = await input.store.find(owner, input.chainId)
      if (existing)
        return {
          address: existing.address,
          transactionHash: existing.deployedTx as Hex,
          created: false,
        }
      const attempt: DeploymentAttempt = {
        id: randomUUID(),
        owner,
        chainId: input.chainId,
        funder,
        manager,
        state: 'PREPARING',
        createdAt: new Date().toISOString(),
      }
      if (!(await input.store.beginDeployment(attempt))) {
        const held = await input.store.find(owner, input.chainId)
        if (held)
          return { address: held.address, transactionHash: held.deployedTx as Hex, created: false }
        const prior = await input.store.pendingDeployment(owner, input.chainId)
        // Another owner's pending deployment must not disclose their hash.
        if (!prior) throw pending()
        if (!prior.transactionHash || prior.manager !== manager || prior.funder !== funder)
          throw pending(prior)
        try {
          const recovered = await complete(
            prior,
            await publicClient.getTransactionReceipt({ hash: prior.transactionHash }),
          )
          return { ...recovered, created: false }
        } catch (error) {
          if (error instanceof ClientError) throw error
          throw pending(prior)
        }
      }
      // constructor(address owner_, address delegationManager_)
      const args = encodeAbiParameters(
        [
          { name: 'owner', type: 'address' },
          { name: 'delegationManager', type: 'address' },
        ],
        [owner, manager],
      )
      let signed: Hex
      try {
        if ((await publicClient.getChainId()) !== input.chainId)
          throw new Error('Deployment RPC chain mismatch.')
        const balance = await publicClient.getBalance({ address: funder })
        if (balance === 0n)
          throw new ClientError(
            'The account-deployment funder has no BNB for gas on this network. No transaction was sent.',
            { statusCode: 503, code: 'ACCOUNT_FUNDER_EMPTY' },
          )
        if (typeof balance !== 'bigint' || balance < 0n)
          throw new Error('Deployment funding is unavailable.')
        const prepared = await wallet.prepareTransactionRequest({
          data: `${MANDATE_ACCOUNT_BYTECODE}${args.slice(2)}` as Hex,
        })
        if (
          typeof prepared.nonce !== 'number' ||
          !Number.isSafeInteger(prepared.nonce) ||
          prepared.nonce < 0
        )
          throw new Error('Deployment nonce is not verified.')
        signed = await wallet.signTransaction(prepared)
        attempt.transactionHash = keccak256(signed)
        attempt.expectedAddress = getContractAddress({
          from: funder,
          nonce: BigInt(prepared.nonce),
        }).toLowerCase() as Address
        await input.store.recordDeploymentHash(
          attempt.id,
          attempt.transactionHash,
          attempt.expectedAddress,
        )
      } catch (error) {
        // Even if hash persistence committed before its acknowledgement failed,
        // this branch knows signed bytes were never passed to a broadcaster.
        await input.store.finishDeployment(attempt.id, 'REFUSED').catch(() => {})
        if (error instanceof ClientError) throw error
        throw new ClientError(
          'The account deployment could not be prepared safely. Nothing was broadcast.',
          { statusCode: 503, code: 'ACCOUNT_DEPLOY_FAILED' },
        )
      }
      try {
        await publicClient.sendRawTransaction({ serializedTransaction: signed })
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: attempt.transactionHash,
          confirmations: 3,
          checkReplacement: false,
          timeout: 60_000,
        })
        return await complete(attempt, receipt)
      } catch (error) {
        if (error instanceof ClientError) throw error
        return uncertain(attempt)
      }
    },
  }
}
