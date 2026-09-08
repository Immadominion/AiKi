import { assertChainConfiguration } from './assertions.js'
import { BSC_MAINNET } from './chains.js'
import { createRpcClient } from './rpc.js'

const rpcUrl = process.env.BSC_RPC_URL
if (!rpcUrl)
  throw new Error(
    'BSC_RPC_URL is required. Use an archive-capable BSC endpoint for production indexing.',
  )
const report = await assertChainConfiguration(createRpcClient(rpcUrl), BSC_MAINNET)
console.log(`Verified ${BSC_MAINNET.name} (chain ${report.chainId}).`)
console.log(`ERC-8183 implementation: ${report.commerceImplementation}`)
for (const contract of report.contracts)
  console.log(
    `${contract.label}: ${contract.address} (${contract.codeBytes.toLocaleString()} bytes)`,
  )
