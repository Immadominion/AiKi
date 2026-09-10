export const PUBLIC_READ_DEADLINE_MS = 10_000

/** Only public evidence reads opt in. Never abandon a financial mutation this way. */
export async function withPublicReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Public evidence read timed out. Please try again.')
      error.name = 'TimeoutError'
      // Reject independently of transport cancellation, including a stalled body.
      reject(error)
      controller.abort(error)
    }, PUBLIC_READ_DEADLINE_MS)
  })
  try {
    // race attaches both rejection handlers, including to a late transport failure.
    return await Promise.race([read(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
