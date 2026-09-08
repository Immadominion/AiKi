/**
 * What may be asked for.
 *
 * An allowlist, not a filter. A marketplace where an agent can post arbitrary
 * free text as paid work for a human is a known abuse surface with measured
 * prices attached: mass account creation at a median of $13 an account,
 * professional identity proxying at $60 an hour, one-time-code solicitation,
 * and geolocated photography sold as reconnaissance (arXiv 2602.19514, which
 * surveyed a live agent-hires-human marketplace).
 *
 * Screening free text catches some of that. Refusing to represent it catches
 * all of it: there is no `kind` here under which "make me forty accounts on
 * this exchange" can be posted, so the request has no shape in the system
 * rather than a shape somebody has to detect.
 *
 * Everything here has one property in common. The work can be judged from what
 * is handed in, by the person who asked for it, without anyone's credentials
 * changing hands and without a third party being deceived about who they are
 * dealing with.
 *
 * Deliberately absent, and it should stay that way: creating accounts, holding
 * or entering somebody else's credentials, receiving codes on another person's
 * behalf, appearing as somebody else, engagement or referral campaigns, and
 * anything whose output is a photograph of a specific place or person.
 */
export const TASK_KINDS = {
  research: 'Find something out and say where you found it',
  review: 'Read something and give an opinion on it',
  writing: 'Write something',
  data: 'Label, clean, or structure data',
  translation: 'Translate something',
  design: 'Make something visual',
  code: 'Write or review code',
  verify: 'Check a public claim: a contract, a site, a filing',
} as const

export type TaskKind = keyof typeof TASK_KINDS

export const isTaskKind = (value: unknown): value is TaskKind =>
  typeof value === 'string' && Object.hasOwn(TASK_KINDS, value)

/**
 * Kinds where the answer is used to make a decision about money.
 *
 * A mandate that says to ask before acting asks before posting one of these,
 * because the failure mode is not "the work was poor". It is an agent buying a
 * confident wrong answer and then trading on it, which the person who set the
 * limits would want to see coming rather than read about afterwards.
 */
export const CONSEQUENTIAL: ReadonlySet<TaskKind> = new Set(['verify', 'review', 'research'])
