import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  type StrategyWalletAction,
  type StrategyWalletActionRequest,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import { decodeEventLog, encodeFunctionData, type Hex, parseAbi } from 'viem'
import { ClientError } from '../http/errors.js'
import { quoteAtTick, sqrtRatioAtTick } from './grid/math.js'
import { amountsForLiquidity } from './lp/liquidity.js'
import { readLPPoolState } from './lp/market.js'
import { nonzeroHash } from './operation.js'
import {
  isVerifiedStrategySnapshot,
  type StrategySnapshotReader,
  type VerifiedStrategySnapshot,
} from './snapshot.js'

export interface StrategySetupActionReader extends StrategySnapshotReader {
  call(input: {
    account: Hex
    to: Hex
    data: Hex
    value: 0n
    blockNumber: bigint
  }): Promise<unknown>
  getTransaction(input: { hash: Hex }): Promise<unknown>
  getTransactionReceipt(input: { hash: Hex }): Promise<unknown>
  getBalance(input: { address: Hex; blockNumber: bigint }): Promise<bigint>
}
const TOKEN = parseAbi([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function decimals() view returns(uint8)',
  'function approve(address,uint256) returns(bool)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
])
const NFT = parseAbi([
  'function ownerOf(uint256) view returns(address)',
  'function getApproved(uint256) view returns(address)',
  'function approve(address,uint256)',
  'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'event Approval(address indexed owner,address indexed approved,uint256 indexed tokenId)',
])
const error = (
  message = 'The reviewed wallet action could not be prepared from current verified state.',
) => new ClientError(message, { statusCode: 409, code: 'STRATEGY_WALLET_NOT_READY' })
const amount = (value: unknown, positive = false): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78)
    throw error('Amounts must be exact raw-unit decimal strings.')
  const n = BigInt(value)
  if (n >= 1n << 256n || (positive && n === 0n)) throw error()
  return n
}
const same = (value: unknown, expected: string) =>
  typeof value === 'string' && value.toLowerCase() === expected.toLowerCase()
const keys = (value: object, expected: string[]) => {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    throw error('This wallet request contains unsupported fields.')
}
type PreparedAction = Omit<StrategyWalletAction, 'id' | 'status' | 'transactionHash'>

/** Returns ONE reviewed owner transaction. An approval never also funds or resumes. */
export async function prepareStrategyWalletAction(input: {
  snapshot: VerifiedStrategySnapshot
  owner: Hex
  request: StrategyWalletActionRequest
  reader: StrategySetupActionReader
  poolRuntimeCodeHash?: Hex
}): Promise<PreparedAction> {
  try {
    const { snapshot, reader } = input,
      request = structuredClone(input.request),
      owner = input.owner.toLowerCase() as Hex
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      snapshot.owner !== owner ||
      (await reader.getChainId()) !== 56
    )
      throw error()
    const s = snapshot.state,
      vault = snapshot.binding.vault
    const transaction = (to: Hex, data: Hex) => ({
      chainId: 56 as const,
      from: owner,
      to,
      data,
      value: '0' as const,
    })
    const vaultAbi =
      s.kind === 'yield'
        ? YieldAllocationVaultAbi
        : s.kind === 'grid'
          ? GridStrategyVaultAbi
          : PancakeLPVaultAbi
    const read = (
      address: Hex,
      abi: typeof TOKEN | typeof NFT,
      functionName: string,
      args?: readonly unknown[],
    ) =>
      reader.readContract({
        address,
        abi,
        functionName,
        ...(args ? { args } : {}),
        blockNumber: snapshot.block.number,
      })
    const metadata = async (token: Hex, value: bigint) => {
      const decimals = await read(token, TOKEN, 'decimals')
      if (
        typeof decimals !== 'number' ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 36
      )
        throw error()
      return { token, amount: value.toString(), decimals }
    }
    const approval = async (token: Hex, value: bigint): Promise<PreparedAction | null> => {
      const [held, allowed] = await Promise.all([
        read(token, TOKEN, 'balanceOf', [owner]),
        read(token, TOKEN, 'allowance', [owner, vault]),
      ])
      if (
        typeof held !== 'bigint' ||
        held < value ||
        typeof allowed !== 'bigint' ||
        allowed < 0n ||
        allowed >= 1n << 256n
      )
        throw error(
          'The owner wallet balance or allowance is not ready for this exact funding amount.',
        )
      if (allowed === value) return null
      const next = allowed === 0n ? value : 0n
      return {
        kind: next === 0n ? 'approve_reset' : 'approve',
        transaction: transaction(
          token,
          encodeFunctionData({ abi: TOKEN, functionName: 'approve', args: [vault, next] }),
        ),
        review: {
          summary:
            next === 0n
              ? 'Reset the existing allowance before an exact approval.'
              : 'Approve only this exact amount to the reviewed strategy vault.',
          assets: [await metadata(token, next)],
          recipient: vault,
        },
      }
    }
    let action: PreparedAction
    if (request.kind === 'resume' || request.kind === 'pause') {
      keys(request, ['kind'])
      if (
        (request.kind === 'resume' && !snapshot.paused) ||
        (request.kind === 'pause' && snapshot.paused)
      )
        throw error('This vault is already in the requested onchain pause state.')
      action = {
        kind: request.kind,
        transaction: transaction(
          vault,
          encodeFunctionData({ abi: vaultAbi, functionName: request.kind }),
        ),
        review: {
          summary:
            request.kind === 'resume'
              ? 'Enable the immutable vault on chain. This does not start the AiKi scheduler.'
              : 'Pause the vault on chain. AiKi service pause is a separate control.',
          recipient: owner,
        },
      }
    } else if (request.kind === 'enroll' && s.kind === 'lp') {
      keys(request, ['kind', 'tokenId'])
      const id = amount(request.tokenId, true)
      if (!snapshot.paused || s.enrolled)
        throw error('Pause and use a new, unenrolled LP vault before enrolling a position.')
      const nfpm = s.protocol.positionManager,
        [held, approved] = await Promise.all([
          read(nfpm, NFT, 'ownerOf', [id]),
          read(nfpm, NFT, 'getApproved', [id]),
        ])
      if (!same(held, owner) || typeof approved !== 'string')
        throw error('This position NFT must belong to the signed-in owner.')
      // Validate the actual position BEFORE asking for even its token-specific approval.
      const position = await read(nfpm, NFT, 'positions', [id])
      if (
        !Array.isArray(position) ||
        position.length !== 12 ||
        !same(position[2], s.protocol.token0) ||
        !same(position[3], s.protocol.token1) ||
        position[4] !== s.protocol.fee ||
        typeof position[5] !== 'number' ||
        typeof position[6] !== 'number' ||
        !Number.isSafeInteger(position[5]) ||
        !Number.isSafeInteger(position[6]) ||
        position[5] < -887272 ||
        position[6] > 887272 ||
        position[5] >= position[6] ||
        position[5] % s.protocol.tickSpacing !== 0 ||
        position[6] % s.protocol.tickSpacing !== 0 ||
        typeof position[7] !== 'bigint' ||
        position[7] <= 0n ||
        position[7] >= 1n << 128n ||
        typeof position[10] !== 'bigint' ||
        position[10] < 0n ||
        typeof position[11] !== 'bigint' ||
        position[11] < 0n ||
        !nonzeroHash(input.poolRuntimeCodeHash)
      )
        throw error(
          'The position does not belong to this reviewed pool or has no eligible liquidity.',
        )
      const pool = await readLPPoolState(
        snapshot,
        { runtimeCodeHash: input.poolRuntimeCodeHash },
        reader,
      )
      if (pool.status !== 'verified')
        throw error('The retained LP oracle and pool liquidity are not ready.')
      const [amount0, amount1] = amountsForLiquidity(
        pool.market.sqrtPriceX96,
        sqrtRatioAtTick(position[5]),
        sqrtRatioAtTick(position[6]),
        position[7],
      )
      const total0 = amount0 + position[10],
        total1 = amount1 + position[11]
      if (total0 >= 1n << 128n || total1 >= 1n << 128n) throw error()
      const value =
        s.protocol.quoteToken === s.protocol.token0
          ? total0 + quoteAtTick(pool.market.twap, total1, s.protocol.token1, s.protocol.token0)
          : total1 + quoteAtTick(pool.market.twap, total0, s.protocol.token0, s.protocol.token1)
      if (value === 0n || value > s.limits.maxPositionValueQuote)
        throw error('This position exceeds the reviewed enrollment value limit.')
      const approve = !same(approved, vault)
      action = {
        kind: approve ? 'approve_nft' : 'enroll',
        transaction: approve
          ? transaction(
              nfpm,
              encodeFunctionData({ abi: NFT, functionName: 'approve', args: [vault, id] }),
            )
          : transaction(
              vault,
              encodeFunctionData({ abi: PancakeLPVaultAbi, functionName: 'enroll', args: [id] }),
            ),
        review: {
          summary: approve
            ? 'Approve this position NFT only, never all NFTs.'
            : 'Enroll this exact position NFT in the reviewed vault.',
          tokenId: id.toString(),
          recipient: vault,
        },
      }
    } else if (request.kind === 'fund' && s.kind === 'yield' && 'assets' in request) {
      keys(request, ['kind', 'assets'])
      const n = amount(request.assets, true)
      if (
        !snapshot.paused ||
        snapshot.expiresAt <= snapshot.block.timestamp ||
        s.fundedPrincipal + n > s.limits.maxPrincipal
      )
        throw error('Funding exceeds the immutable principal limit or the vault is not paused.')
      action = (await approval(s.protocol.underlying, n)) ?? {
        kind: 'fund',
        transaction: transaction(
          vault,
          encodeFunctionData({ abi: YieldAllocationVaultAbi, functionName: 'fund', args: [n] }),
        ),
        review: {
          summary: 'Fund the paused vault with this exact underlying amount.',
          assets: [await metadata(s.protocol.underlying, n)],
          recipient: vault,
        },
      }
    } else if (request.kind === 'fund' && s.kind === 'grid' && 'rungIndex' in request) {
      keys(request, ['kind', 'rungIndex', 'amount0', 'amount1'])
      const n0 = amount(request.amount0),
        n1 = amount(request.amount1),
        index = request.rungIndex
      if (
        !snapshot.paused ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= s.rungs.length ||
        n0 + n1 === 0n ||
        s.funded0 + n0 > s.policy.fundingCap0 ||
        s.funded1 + n1 > s.policy.fundingCap1
      )
        throw error('The funded rung or immutable funding caps are not ready.')
      action = (n0 > 0n ? await approval(s.protocol.token0, n0) : null) ??
        (n1 > 0n ? await approval(s.protocol.token1, n1) : null) ?? {
          kind: 'fund',
          transaction: transaction(
            vault,
            encodeFunctionData({
              abi: GridStrategyVaultAbi,
              functionName: 'fund',
              args: [index, n0, n1],
            }),
          ),
          review: {
            summary: 'Fund this one rung with exact token amounts.',
            assets: [await metadata(s.protocol.token0, n0), await metadata(s.protocol.token1, n1)],
            rungIndex: index,
            recipient: vault,
          },
        }
    } else if (request.kind === 'withdraw' && s.kind === 'yield' && 'token' in request) {
      keys(request, ['kind', 'token', 'amount'])
      const n = amount(request.amount, true),
        token = request.token.toLowerCase() as Hex
      if (![s.protocol.underlying, s.protocol.venus, s.protocol.aaveReceipt].includes(token))
        throw error(
          'Only this vault’s reviewed underlying or receipt tokens may be recovered here.',
        )
      action = {
        kind: 'withdraw',
        transaction: transaction(
          vault,
          encodeFunctionData({
            abi: YieldAllocationVaultAbi,
            functionName: 'recover',
            args: [token, n],
          }),
        ),
        review: {
          summary:
            'Recover exact underlying or receipt tokens to the owner wallet. Pending plans become invalid.',
          assets: [await metadata(token, n)],
          recipient: owner,
        },
      }
    } else if (request.kind === 'withdraw' && s.kind === 'grid' && 'rungIndex' in request) {
      keys(request, ['kind', 'rungIndex', 'amount0', 'amount1'])
      const n0 = amount(request.amount0),
        n1 = amount(request.amount1),
        r = s.rungs[request.rungIndex]
      if (
        !Number.isSafeInteger(request.rungIndex) ||
        !r ||
        n0 + n1 === 0n ||
        n0 > r.state.inventory0 ||
        n1 > r.state.inventory1
      )
        throw error()
      action = {
        kind: 'withdraw',
        transaction: transaction(
          vault,
          encodeFunctionData({
            abi: GridStrategyVaultAbi,
            functionName: 'withdraw',
            args: [request.rungIndex, n0, n1, owner],
          }),
        ),
        review: {
          summary: 'Withdraw only this rung’s owned inventory. Pending plans become invalid.',
          assets: [await metadata(s.protocol.token0, n0), await metadata(s.protocol.token1, n1)],
          rungIndex: request.rungIndex,
          recipient: owner,
        },
      }
    } else if (request.kind === 'withdraw' && s.kind === 'lp') {
      keys(request, ['kind'])
      if (s.currentTokenId === 0n) throw error()
      action = {
        kind: 'withdraw',
        transaction: transaction(
          vault,
          encodeFunctionData({ abi: PancakeLPVaultAbi, functionName: 'withdrawPosition' }),
        ),
        review: {
          summary:
            'Withdraw the current position NFT and tracked idle tokens to the owner. This vault cannot enroll again.',
          tokenId: s.currentTokenId.toString(),
          recipient: owner,
        },
      }
    } else throw error('This action does not match the immutable strategy kind.')
    const response = await reader.call({
      account: owner,
      to: action.transaction.to,
      data: action.transaction.data,
      value: 0n,
      blockNumber: snapshot.block.number,
    })
    if (action.kind === 'approve' || action.kind === 'approve_reset') {
      const data =
        response && typeof response === 'object' ? (response as { data?: unknown }).data : response
      if (data !== `0x${'0'.repeat(63)}1`)
        throw error('The token did not confirm the exact approval simulation.')
    }
    const block = (await reader.getBlock({ blockNumber: snapshot.block.number })) as {
      number?: unknown
      hash?: unknown
      timestamp?: unknown
    } | null
    if (
      !block ||
      block.number !== snapshot.block.number ||
      !same(block.hash, snapshot.block.hash) ||
      block.timestamp !== snapshot.block.timestamp ||
      (await reader.getChainId()) !== 56
    )
      throw error()
    return action
  } catch (cause) {
    if (cause instanceof ClientError) throw cause
    throw error()
  }
}

/** Exact owner call, exact persisted hash, finalized then canonical. No replacement lookup. */
export async function verifyStrategyWalletReceipt(
  action: StrategyWalletAction,
  reader: StrategySetupActionReader,
): Promise<{ status: 'FINALIZED' | 'REVERTED'; block: { number: string; hash: Hex } } | null> {
  try {
    const target = structuredClone(action),
      hash = target.transactionHash
    if (!nonzeroHash(hash) || (await reader.getChainId()) !== 56) return null
    const receipt = (await reader.getTransactionReceipt({ hash })) as Record<string, unknown> | null
    const tx = (await reader.getTransaction({ hash })) as Record<string, unknown> | null
    if (
      !receipt ||
      !tx ||
      !same(receipt.transactionHash, hash) ||
      !same(tx.hash, hash) ||
      !nonzeroHash(receipt.blockHash) ||
      typeof receipt.blockNumber !== 'bigint' ||
      receipt.blockNumber < 0n ||
      tx.blockNumber !== receipt.blockNumber ||
      !same(tx.blockHash, receipt.blockHash) ||
      !same(tx.from, target.transaction.from) ||
      !same(tx.to, target.transaction.to) ||
      !same(tx.input, target.transaction.data) ||
      tx.value !== 0n ||
      (tx.chainId !== undefined && tx.chainId !== 56) ||
      (receipt.status !== 'success' && receipt.status !== 'reverted')
    )
      return null
    if (
      receipt.status === 'success' &&
      ['approve', 'approve_reset', 'approve_nft'].includes(target.kind)
    ) {
      // An approval can be consumed by another owner transaction in this same block.
      // Prove this exact receipt's effect, then re-read allowance/ownership for the NEXT request.
      const nft = target.kind === 'approve_nft',
        asset = target.review.assets?.[0]
      if (
        !target.review.recipient ||
        !Array.isArray(receipt.logs) ||
        (nft ? !target.review.tokenId : !asset || !same(asset.token, target.transaction.to))
      )
        return null
      let matches = 0
      for (const raw of receipt.logs) {
        if (!raw || typeof raw !== 'object' || !same(raw.address, target.transaction.to)) continue
        if (
          raw.removed === true ||
          !same(raw.transactionHash, hash) ||
          !same(raw.blockHash, receipt.blockHash) ||
          raw.blockNumber !== receipt.blockNumber
        )
          return null
        try {
          const event = decodeEventLog({
            abi: nft ? NFT : TOKEN,
            eventName: 'Approval',
            data: raw.data,
            topics: raw.topics,
            strict: true,
          })
          const args = event.args as {
            owner?: unknown
            spender?: unknown
            approved?: unknown
            value?: unknown
            tokenId?: unknown
          }
          if (
            same(args.owner, target.transaction.from) &&
            same(nft ? args.approved : args.spender, target.review.recipient) &&
            (nft
              ? args.tokenId === amount(target.review.tokenId, true)
              : args.value === amount(asset?.amount))
          )
            matches++
        } catch {
          /* Other events from the same reviewed token are irrelevant. */
        }
      }
      if (matches !== 1) return null
    }
    const finalized = (await reader.getBlock({ blockTag: 'finalized' })) as Record<
      string,
      unknown
    > | null
    if (
      !finalized ||
      typeof finalized.number !== 'bigint' ||
      finalized.number < receipt.blockNumber ||
      !nonzeroHash(finalized.hash) ||
      (finalized.number === receipt.blockNumber && !same(finalized.hash, receipt.blockHash))
    )
      return null
    const block = (await reader.getBlock({ blockNumber: receipt.blockNumber })) as Record<
      string,
      unknown
    > | null
    if (
      !block ||
      block.number !== receipt.blockNumber ||
      !same(block.hash, receipt.blockHash) ||
      (await reader.getChainId()) !== 56
    )
      return null
    return {
      status: receipt.status === 'success' ? 'FINALIZED' : 'REVERTED',
      block: {
        number: receipt.blockNumber.toString(),
        hash: receipt.blockHash.toLowerCase() as Hex,
      },
    }
  } catch {
    return null
  }
}
