import type { AssistantTurn, FastConversation, FastConversationMessage } from '../../lib/api'

type WireMessage = { role: 'user' | 'assistant'; content: string }
export interface PendingFastTurn {
  idempotencyKey: string
  messages: WireMessage[]
}
interface DraftStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export interface ConversationTransport {
  create(id: string): Promise<FastConversation>
  load(id: string): Promise<FastConversation>
  ask(
    messages: WireMessage[],
    options: { conversationId: string; idempotencyKey: string },
    /** The composer's setting, read at send time rather than when the controller was made. */
    agentPower?: 'every' | 'over' | 'never',
  ): Promise<AssistantTurn>
}
export interface FastConversationState {
  messages: FastConversationMessage[]
  draft: string
  pending: PendingFastTurn | null
  busy: boolean
  loading: boolean
  error: string | null
  errorCode?: string | undefined
}

export const conversationStorageKey = (owner: string, id: string) =>
  `aiki.fast.conversation.v1:${owner.toLowerCase()}:${id}`

/** Keep complete recent turns within the API budget. Nothing is removed from History. */
export function conversationContext(messages: WireMessage[], question: string): WireMessage[] {
  const context: WireMessage[] = [{ role: 'user', content: question }]
  for (let index = messages.length - 2; index >= 0; index -= 2) {
    const pair = messages.slice(index, index + 2).map(({ role, content }) => ({ role, content }))
    if (pair[0]?.role !== 'user' || pair[1]?.role !== 'assistant') break
    if (JSON.stringify([...pair, ...context]).length > 7500) break
    context.unshift(...pair)
  }
  return context
}

/** Owns one wallet/thread. Restoring it is read-only, including interrupted turns. */
export class FastConversationController {
  private state: FastConversationState = {
    messages: [],
    draft: '',
    pending: null,
    busy: false,
    loading: true,
    error: null,
  }
  private listeners = new Set<() => void>()
  private generation = 0
  private readonly storageKey: string
  constructor(
    readonly id: string,
    owner: string,
    private transport: ConversationTransport,
    private storage: DraftStore | undefined,
    private newKey = () => crypto.randomUUID(),
    /** Reads the composer's current setting at send time. Absent in tests and older callers. */
    private agentPower?: () => 'every' | 'over' | 'never' | undefined,
  ) {
    this.storageKey = conversationStorageKey(owner, id)
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<FastConversationState>) {
    this.state = {
      ...this.state,
      ...(patch.error === null ? { errorCode: undefined } : {}),
      ...patch,
    }
    this.listeners.forEach((listener) => {
      listener()
    })
  }
  private save() {
    try {
      if (!this.state.draft && !this.state.pending) this.storage?.removeItem(this.storageKey)
      else
        this.storage?.setItem(
          this.storageKey,
          JSON.stringify({ draft: this.state.draft, pending: this.state.pending }),
        )
    } catch {
      /* Server history still works when browser storage is unavailable. */
    }
  }
  private restoreDraft(): { draft?: string; pending: PendingFastTurn | null } {
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(this.storageKey) ?? '{}')
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { pending: null }
      const data = saved as { draft?: unknown; pending?: Partial<PendingFastTurn> }
      const pending = data.pending
      const valid =
        pending &&
        typeof pending.idempotencyKey === 'string' &&
        /^[\x21-\x7e]{1,200}$/.test(pending.idempotencyKey) &&
        Array.isArray(pending.messages) &&
        pending.messages.length > 0 &&
        pending.messages.every(
          (message) =>
            message &&
            typeof message === 'object' &&
            !Array.isArray(message) &&
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string',
        )
      return {
        ...(typeof data.draft === 'string' ? { draft: data.draft } : {}),
        pending: valid ? (pending as PendingFastTurn) : null,
      }
    } catch {
      return { pending: null }
    }
  }
  setDraft = (draft: string) => {
    this.update({ draft })
    this.save()
  }
  dispose = () => {
    this.generation += 1
  }

  async initialize(create = false, opening?: string) {
    const generation = ++this.generation
    // A component remount may retain its original create/opening props. Read
    // the retry key first, before saving a draft could overwrite that key.
    const saved = this.restoreDraft()
    const existingPending = this.state.pending ?? saved.pending
    this.update({
      loading: true,
      error: null,
      busy: false,
      pending: existingPending,
      draft: existingPending ? '' : create && opening ? opening : (saved.draft ?? this.state.draft),
    })
    this.save()
    try {
      const conversation = await (create
        ? this.transport.create(this.id)
        : this.transport.load(this.id))
      if (generation !== this.generation) return
      // Another view of this thread may have started its turn while create/load
      // was pending. Keep that request too, rather than automatically sending.
      const latest = this.restoreDraft()
      const pending = this.state.pending ?? latest.pending
      this.update({
        messages: conversation.messages,
        draft: pending ? '' : (latest.draft ?? this.state.draft),
        pending,
        loading: false,
        error: pending
          ? 'A reply was interrupted. Check the same request below before sending another.'
          : null,
      })
      // Only a fresh explicit Ask can submit. Opening History never does.
      if (create && opening && !pending && conversation.messages.length === 0)
        await this.send(opening)
    } catch (error) {
      if (generation === this.generation)
        this.update({ loading: false, error: (error as Error).message })
    }
  }

  async send(question = this.state.draft.trim()) {
    if (this.state.busy || this.state.loading || (!question && !this.state.pending)) return
    const generation = this.generation
    const pending = this.state.pending ?? {
      idempotencyKey: this.newKey(),
      messages: conversationContext(this.state.messages, question),
    }
    /*
     * The box empties on send, the way every message box does.
     *
     * It used to keep the question, so the same sentence sat in the composer
     * and in the thread at once and the send looked like it had not happened.
     * The text was kept for the retry path, and the retry path never needed it:
     * `send` re-uses `pending.messages` whenever a pending turn exists and
     * ignores the draft entirely. A pending turn draws the question as its own
     * bubble, so the composer would only be showing it twice, and a turn that
     * is refused before any charge puts the question back below, where the
     * bubble it had is now gone and the person has a correction to make.
     */
    this.update({ pending, draft: '', busy: true, error: null })
    this.save()
    try {
      await this.transport.ask(
        pending.messages,
        { conversationId: this.id, idempotencyKey: pending.idempotencyKey },
        /*
         * Read now, not when this controller was built. Somebody who changes
         * the setting and then sends means the setting they can see, and a
         * value captured at construction would be the one they changed away
         * from.
         */
        this.agentPower?.(),
      )
      if (generation !== this.generation) return
      // Always restore the authoritative thread, including partial tool failures.
      const conversation = await this.transport.load(this.id)
      if (generation !== this.generation) return
      this.update({
        messages: conversation.messages,
        draft: '',
        pending: null,
        busy: false,
        error: null,
      })
      this.save()
    } catch (error) {
      if (generation !== this.generation) return
      const failure = error as Error & { status?: number; code?: string }
      if (
        [
          'ASSISTANT_TURN_FAILED',
          'ASSISTANT_USAGE_UNCONFIRMED',
          'ASSISTANT_SETTLEMENT_UNCONFIRMED',
          'ASSISTANT_BUDGET_TOO_SMALL',
        ].includes(failure.code ?? '')
      ) {
        try {
          const conversation = await this.transport.load(this.id)
          if (generation !== this.generation) return
          // An uncertain turn can already have saved work and usage. Show it,
          // but keep its exact request locked until settlement is confirmed.
          const uncertain =
            failure.code === 'ASSISTANT_USAGE_UNCONFIRMED' ||
            failure.code === 'ASSISTANT_SETTLEMENT_UNCONFIRMED'
          this.update({
            messages: conversation.messages,
            busy: false,
            pending: uncertain ? pending : null,
            draft: uncertain ? (pending.messages.at(-1)?.content ?? '') : '',
            error: failure.message,
            errorCode: failure.code,
          })
          this.save()
          return
        } catch {
          if (generation !== this.generation) return
          // Even a known 402 may have recorded a reply. Do not permit a new
          // request with stale context until that result can be retrieved.
          this.update({ busy: false, error: failure.message, errorCode: failure.code })
          this.save()
          return
        }
      }
      const refused =
        failure.status === 400 ||
        failure.status === 402 ||
        [
          'CONVERSATION_CHANGED',
          'CONVERSATION_NOT_FOUND',
          'CONVERSATIONS_UNAVAILABLE',
          'CONVERSATION_UNAVAILABLE',
          'ASSISTANT_UNAVAILABLE',
        ].includes(failure.code ?? '')
      this.update({
        busy: false,
        error: failure.message,
        errorCode: failure.code,
        // Nothing was charged and the pending bubble goes with it, so the
        // question returns to the composer rather than leaving the person to
        // retype what they had just written.
        ...(refused ? { pending: null, draft: pending.messages.at(-1)?.content ?? '' } : {}),
      })
      this.save()
    }
  }
}
