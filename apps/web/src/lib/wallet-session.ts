/** Only a verified wallet may attach the browser's SIWE cookie to API calls. */
let revision = 0
let address: string | null = null
let controller = new AbortController()
const listeners = new Set<() => void>()

export function subscribeWalletSession(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function walletSession() {
  return { revision, address, signal: controller.signal }
}

export function invalidateWalletSession() {
  controller.abort()
  controller = new AbortController()
  address = null
  ++revision
  for (const listener of listeners) listener()
  return revision
}

export function acceptWalletSession(walletAddress: string, expectedRevision: number) {
  if (revision !== expectedRevision) return false
  address = walletAddress.toLowerCase()
  for (const listener of listeners) listener()
  return true
}

export function isWalletSessionCurrent(expectedRevision: number) {
  return revision === expectedRevision
}
