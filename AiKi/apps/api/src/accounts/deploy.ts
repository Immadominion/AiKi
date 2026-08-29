import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ClientError } from '../http/errors.js'
import { MANDATE_ACCOUNT_BYTECODE } from './bytecode.js'

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
  deploy(owner: Address): Promise<{ address: Address; transactionHash: Hex }>
}

export function viemAccountDeployer(input: {
  rpcUrl: string
  chainId: number
  manager: Address
  /** Pays gas to deploy. Holds no authority over anything it deploys. */
  funderKey: Hex
}): AccountDeployer {
  const chain = {
    id: input.chainId,
    name: `chain-${input.chainId}`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  } as const
  const transport = http(input.rpcUrl)
  const publicClient = createPublicClient({ chain, transport })
  const wallet = createWalletClient({
    account: privateKeyToAccount(input.funderKey),
    chain,
    transport,
  })

  return {
    async deploy(owner) {
      // constructor(address owner_, address delegationManager_)
      const args = encodeAbiParameters(
        [
          { name: 'owner', type: 'address' },
          { name: 'delegationManager', type: 'address' },
        ],
        [owner, input.manager],
      )
      const hash = await wallet.deployContract({
        abi: [],
        bytecode: `${MANDATE_ACCOUNT_BYTECODE}${args.slice(2)}` as Hex,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success' || !receipt.contractAddress)
        // Reported rather than thrown as a generic failure, because a deployment
        // that reverted is a fact about the chain and not a bug in this process.
        throw new ClientError('The account could not be deployed. Try again shortly.', {
          statusCode: 502,
          code: 'ACCOUNT_DEPLOY_FAILED',
        })
      return { address: receipt.contractAddress, transactionHash: hash }
    },
  }
}
