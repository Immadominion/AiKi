export class MarketplaceError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly retryable: boolean
  readonly details: Readonly<Record<string, string>>

  constructor(
    code: string,
    message: string,
    options: {
      statusCode?: number
      retryable?: boolean
      details?: Record<string, string>
    } = {},
  ) {
    super(message)
    this.name = 'MarketplaceError'
    this.code = code
    this.statusCode = options.statusCode ?? 400
    this.retryable = options.retryable ?? false
    this.details = Object.freeze({ ...(options.details ?? {}) })
  }
}

export class IdempotencyConflictError extends MarketplaceError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for another request.', {
      statusCode: 409,
    })
  }
}

export class CommandInProgressError extends MarketplaceError {
  constructor() {
    super('COMMAND_IN_PROGRESS', 'An identical command is still being processed.', {
      statusCode: 409,
      retryable: true,
    })
  }
}
