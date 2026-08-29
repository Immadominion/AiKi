/**
 * The line between an error written for a user and one written for us.
 *
 * The global handler used to return `error.message` verbatim with a 400 on every
 * throw. Deliberate validation messages read well that way, but the same path
 * carried whatever a Postgres driver, an RPC client or a failed fetch had to say
 * — connection targets, hostnames, driver internals — straight to the caller, and
 * labelled genuine faults as the caller's fault.
 *
 * A message is only shown when it was written to be shown. Everything else gets
 * a generic reply and a request id, and the real text goes to the log where it
 * is useful and not disclosed.
 */
export class ClientError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message)
    this.name = 'ClientError'
    this.statusCode = options.statusCode ?? 400
    this.code = options.code ?? 'BAD_REQUEST'
  }
}

/** Returns the error when it was written for a caller, otherwise null. */
export function asClientError(error: unknown): ClientError | null {
  return error instanceof ClientError ? error : null
}

/**
 * Fastify's own schema failures. Its messages name the offending field and were
 * written for whoever sent the request, so they are safe to return; anything
 * without a `validation` array came from our code and is not.
 */
export function asSchemaError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { validation?: unknown; message?: unknown }
  if (!Array.isArray(candidate.validation)) return null
  return typeof candidate.message === 'string' ? candidate.message : 'Request failed validation.'
}
