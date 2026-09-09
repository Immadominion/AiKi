import type { Address, Hex } from 'viem'

export type DeploymentState =
  | 'PREPARING'
  | 'SUBMITTED'
  | 'UNCONFIRMED'
  | 'LANDED'
  | 'REFUSED'
  | 'REVERTED'

export interface DeploymentAttempt {
  id: string
  owner: Address
  chainId: number
  funder: Address
  manager: Address
  state: DeploymentState
  transactionHash?: Hex
  expectedAddress?: Address
  createdAt: string
}

export const deploymentPending = (state: DeploymentState) =>
  state === 'PREPARING' || state === 'SUBMITTED' || state === 'UNCONFIRMED'

export function deploymentAddress(value: string): Address {
  if (!/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value))
    throw new Error('Account deployment address is invalid.')
  return value.toLowerCase() as Address
}
