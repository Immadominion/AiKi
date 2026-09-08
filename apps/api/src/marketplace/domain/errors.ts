export class MarketplaceDomainError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, string>>

  constructor(code: string, message: string, details: Record<string, string> = {}) {
    super(message)
    this.name = 'MarketplaceDomainError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export class InvalidTransitionError extends MarketplaceDomainError {
  constructor(machine: string, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', `${machine} cannot move from ${from} to ${to}.`, {
      machine,
      from,
      to,
    })
    this.name = 'InvalidTransitionError'
  }
}

export class InvalidAmountError extends MarketplaceDomainError {
  constructor(value: string, reason: string) {
    super('INVALID_BASE_UNIT_AMOUNT', `Invalid base-unit amount: ${reason}.`, { value, reason })
    this.name = 'InvalidAmountError'
  }
}
