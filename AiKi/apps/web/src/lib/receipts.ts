/**
 * Client-side receipt verification: nothing here trusts the server's verdict.
 *
 * The aiki-scitt-cose/v1 canonical form is JSON with all object keys deeply
 * sorted, so a verifier can rebuild the signed bytes from the wire receipt
 * regardless of serialization order. The hash is SHA-256 of that canonical
 * string; the signature is Ed25519 over the ASCII hex of the hash.
 */
export interface WireReceipt {
  receiptId: string
  jobId: string
  mandateHash: string
  actions: unknown[]
  startedAt: string
  completedAt: string
  payloadHash: string
  signature: string
  alg: string
  profile: string
}

export type Verdict = 'verified' | 'hash_mismatch' | 'bad_signature' | 'unsupported'

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

const b64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

export async function verifyReceipt(receipt: WireReceipt, publicKey: string): Promise<Verdict> {
  const { payloadHash, signature, ...body } = receipt
  const canonical = JSON.stringify(sortDeep(body))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (hex !== payloadHash) return 'hash_mismatch'
  try {
    const key = await crypto.subtle.importKey('raw', b64u(publicKey), { name: 'Ed25519' }, false, [
      'verify',
    ])
    const ok = await crypto.subtle.verify(
      'Ed25519',
      key,
      b64u(signature),
      new TextEncoder().encode(payloadHash),
    )
    return ok ? 'verified' : 'bad_signature'
  } catch {
    // A browser without WebCrypto Ed25519 cannot check locally; saying so is
    // the only honest verdict — never fall back to trusting the server.
    return 'unsupported'
  }
}
