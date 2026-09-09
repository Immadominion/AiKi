import type { AssistantTurn } from './run.js'

/** A later failure must never erase provider usage already returned this turn. */
export class AssistantRunFailure extends Error {
  constructor(
    readonly turn: AssistantTurn,
    readonly uncertain: boolean,
  ) {
    super(
      uncertain
        ? 'Fast mode could not confirm the last model request. Known usage is recorded; the remaining points stay held until it is checked.'
        : 'Fast mode stopped before it could finish. Known usage was charged and unused points were returned. Check your work before buying again.',
    )
  }
}
