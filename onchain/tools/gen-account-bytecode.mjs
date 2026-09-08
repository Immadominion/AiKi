// Regenerates apps/api/src/accounts/bytecode.ts from the compiled artifact.
//
// The API deploys mandate accounts, so it needs the creation bytecode, and
// onchain/out is gitignored and absent from the container it runs in. This
// copies the compiled bytes into a committed constant; bytecode.test.ts checks
// the two still agree, so the constant cannot quietly go stale.
//
//   forge build && node onchain/tools/gen-account-bytecode.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const artifact = JSON.parse(
  readFileSync(resolve(HERE, '../out/AiKiMandateAccount.sol/AiKiMandateAccount.json'), 'utf8'),
)
const raw = artifact.bytecode.object
const bytecode = raw.startsWith('0x') ? raw : `0x${raw}`
const out = resolve(HERE, '../../apps/api/src/accounts/bytecode.ts')
const existing = readFileSync(out, 'utf8')
writeFileSync(out, existing.replace(/'0x[0-9a-fA-F]*' as const/, `'${bytecode}' as const`))
console.log(`wrote ${bytecode.length} hex chars to ${out}`)
