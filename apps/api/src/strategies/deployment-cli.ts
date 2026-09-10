/** Unsigned-only CLI. Examples (explicit public JSON paths, no private-key options):
 * pnpm exec tsx src/strategies/deployment-cli.ts infrastructure --owner 0x... --rpc https://...
 * pnpm exec tsx src/strategies/deployment-cli.ts prepare --owner 0x... --input setup.json --config reviewed.json --rpc https://...
 * pnpm exec tsx src/strategies/deployment-cli.ts finalize --prepared preparation.json --transaction-hash 0x... --config reviewed.json --rpc https://...
 * pnpm exec tsx src/strategies/deployment-cli.ts verify-config --config reviewed.json --rpc https://...
 * Prints JSON to stdout only. Never signs/sends, writes config, creates an account or loads a key.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { PreparedStrategyDeployment } from '@aiki/contracts/strategies'
import { createPublicClient, type Hex, http } from 'viem'
import { bsc } from 'viem/chains'
import { finalizeStrategyDeployment, prepareStrategyDeployment } from './deployment.js'
import {
  parseStrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import { prepareStrategyInfrastructure } from './deployment-infrastructure.js'
import { verifyStrategyDeploymentConfiguration } from './deployment-verification.js'
import { nonzeroAddress, nonzeroHash } from './operation.js'

export async function runStrategyDeploymentCli(argv: readonly string[]): Promise<unknown> {
  try {
    const [command, ...rest] = argv
    const options = new Map<string, string>()
    if (rest.length % 2 !== 0) throw Error('arguments')
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i],
        value = rest[i + 1]
      if (!key || !value || options.has(key)) throw Error('arguments')
      options.set(key, value)
    }
    const expected =
      command === 'infrastructure'
        ? ['--owner', '--rpc']
        : command === 'prepare'
          ? ['--owner', '--input', '--config', '--rpc']
          : command === 'finalize'
            ? ['--prepared', '--transaction-hash', '--config', '--rpc']
            : command === 'verify-config'
              ? ['--config', '--rpc']
              : null
    if (!expected || options.size !== expected.length || expected.some((key) => !options.has(key)))
      throw Error('arguments')
    const rpc = new URL(options.get('--rpc') ?? '')
    if (
      rpc.protocol !== 'https:' &&
      !(rpc.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname))
    )
      throw Error('rpc')
    if (
      (command === 'prepare' || command === 'infrastructure') &&
      !nonzeroAddress(options.get('--owner'))
    )
      throw Error('owner')
    if (command === 'finalize' && !nonzeroHash(options.get('--transaction-hash')))
      throw Error('transaction')
    const reader = createPublicClient({
      chain: bsc,
      transport: http(rpc.toString(), { timeout: 12000, retryCount: 0 }),
    })
    if (command === 'infrastructure')
      return prepareStrategyInfrastructure({ owner: options.get('--owner') as Hex, reader })
    const json = async (key: string) => {
      const text = await readFile(options.get(key) ?? '', 'utf8')
      if (text.length > 1000000) throw Error('size')
      return JSON.parse(text)
    }
    const config = parseStrategyDeploymentConfig(await json('--config'))
    if (command === 'verify-config') {
      const result = await verifyStrategyDeploymentConfiguration(config, reader)
      return {
        status: 'verified',
        configurationDigest: strategyDeploymentConfigDigest(config),
        block: {
          number: result.block.number.toString(),
          hash: result.block.hash,
          timestamp: result.block.timestamp.toString(),
        },
      }
    }
    if (command === 'prepare')
      return prepareStrategyDeployment({
        config,
        owner: options.get('--owner') as Hex,
        input: await json('--input'),
        reader,
      })
    const supplied = await json('--prepared')
    const prepared = (
      supplied?.status === 'prepared' ? supplied.prepared : supplied
    ) as PreparedStrategyDeployment
    return finalizeStrategyDeployment({
      config,
      prepared,
      transactionHash: options.get('--transaction-hash') as Hex,
      reader,
    })
  } catch {
    return {
      status: 'blocked',
      reason: 'Invalid unsigned deployment request or unavailable reviewed chain evidence.',
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runStrategyDeploymentCli(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if ((result as { status?: string }).status === 'blocked') process.exitCode = 1
}
