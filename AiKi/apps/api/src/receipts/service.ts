import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto'
import { ClientError } from '../http/errors.js'
import { InMemoryReceiptStore, type ReceiptStore } from './store.js'
export interface ExecutionReceipt {
  receiptId: string
  jobId: string
  mandateHash: string
  actions: unknown[]
  startedAt: string
  completedAt: string
  payloadHash: string
  signature: string
  alg: 'Ed25519'
  profile: 'aiki-scitt-cose/v1'
}
/**
 * aiki-scitt-cose/v1 canonical form: JSON with all object keys sorted, deeply.
 * Key order must never matter — a verifier rebuilds this from the wire receipt
 * without knowing what order the signer's runtime happened to use.
 */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, sortDeep(value)]),
    )
  return v
}
const canonical = (v: unknown) => JSON.stringify(sortDeep(v))

/** RFC 8410 PKCS#8 wrapper for a raw Ed25519 seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function keysFromSeed(seedHex: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex))
    throw new Error('Receipt signing seed must be 32 bytes of hex.')
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

export class ReceiptService {
  private readonly keys: ReturnType<typeof keysFromSeed>
  private readonly store: ReceiptStore

  /**
   * A receipt outlives the process that signed it, so the signing key must
   * too: pass a stable 32-byte hex seed (RECEIPT_SIGNING_KEY) in production.
   * Without one the key is ephemeral and every restart orphans old receipts —
   * acceptable only where the receipts are as disposable as the process.
   */
  constructor(seedHex?: string, store: ReceiptStore = new InMemoryReceiptStore()) {
    this.keys = seedHex ? keysFromSeed(seedHex) : generateKeyPairSync('ed25519')
    this.store = store
  }

  /** Raw 32-byte Ed25519 public key, base64url: what a verifier pins. */
  publicKey(): string {
    const spki = this.keys.publicKey.export({ format: 'der', type: 'spki' })
    return Buffer.from(spki.subarray(spki.length - 32)).toString('base64url')
  }
  async create(
    input: Omit<ExecutionReceipt, 'receiptId' | 'payloadHash' | 'signature' | 'alg' | 'profile'>,
  ): Promise<ExecutionReceipt> {
    const receiptId = createHash('sha256')
      .update(`${input.jobId}:${input.completedAt}`)
      .digest('hex')
      .slice(0, 32)
    const body = {
      receiptId,
      ...input,
      alg: 'Ed25519' as const,
      profile: 'aiki-scitt-cose/v1' as const,
    }
    const payloadHash = createHash('sha256').update(canonical(body)).digest('hex')
    const signature = sign(null, Buffer.from(payloadHash), this.keys.privateKey).toString(
      'base64url',
    )
    const receipt = { ...body, payloadHash, signature }
    await this.store.put(receipt)
    return receipt
  }
  async get(id: string) {
    const receipt = await this.store.get(id)
    if (!receipt)
      throw new ClientError('Receipt not found.', { statusCode: 404, code: 'NOT_FOUND' })
    return receipt
  }
  verify(receipt: ExecutionReceipt) {
    const { payloadHash, signature, ...body } = receipt
    if (createHash('sha256').update(canonical(body)).digest('hex') !== payloadHash) return false
    return verify(
      null,
      Buffer.from(payloadHash),
      this.keys.publicKey,
      Buffer.from(signature, 'base64url'),
    )
  }
}
