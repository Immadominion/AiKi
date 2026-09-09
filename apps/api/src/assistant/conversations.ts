import postgres from 'postgres'
import { ClientError } from '../http/errors.js'
import type { AssistantStep } from './run.js'

export interface ConversationMessage {
  id: string
  turnId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  status?: 'completed' | 'failed'
  steps?: AssistantStep[]
  cost?: {
    points: number
    balance: number
    held: number
    explanation: string
    pendingPoints?: number
  }
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  lastMessage: string | null
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[]
}

type InputMessage = { role: string; content: unknown }
export interface RecordedConversationTurn {
  owner: string
  conversationId: string
  turnId: string
  messages: readonly InputMessage[]
  reply: string
  steps: NonNullable<ConversationMessage['steps']>
  cost: NonNullable<ConversationMessage['cost']>
  status: 'completed' | 'failed'
}

export interface ConversationStore {
  create(owner: string, id: string): Promise<Conversation>
  list(
    owner: string,
    before?: string,
  ): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }>
  get(owner: string, id: string): Promise<Conversation | null>
  prepare(owner: string, id: string, messages: readonly InputMessage[]): Promise<void>
  record(input: RecordedConversationTurn): Promise<void>
  close(): Promise<void>
}

export const validConversationId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

const missing = () =>
  new ClientError('This conversation is not available for your wallet.', {
    code: 'CONVERSATION_NOT_FOUND',
    statusCode: 404,
  })

export function validateConversationContext(
  history: ConversationMessage[],
  input: readonly InputMessage[],
) {
  if (
    !input.length ||
    input.at(-1)?.role !== 'user' ||
    input.some(
      (message, i) =>
        typeof message.content !== 'string' ||
        !message.content.trim() ||
        message.role !== (i % 2 === 0 ? 'user' : 'assistant'),
    )
  ) {
    throw new ClientError('Send a new message after the saved conversation.', {
      code: 'CONVERSATION_MESSAGES_INVALID',
    })
  }
  const prefix = input.slice(0, -1)
  const saved = history.slice(-prefix.length)
  if (
    prefix.length > history.length ||
    prefix.some(
      (message, index) =>
        message.role !== saved[index]?.role || message.content !== saved[index]?.content,
    )
  ) {
    throw new ClientError(
      'This conversation has a newer reply. Reload it before sending another message.',
      {
        code: 'CONVERSATION_CHANGED',
        statusCode: 409,
      },
    )
  }
}

const iso = (value: string | Date) => new Date(value).toISOString()
function summary(row: Record<string, unknown>): ConversationSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: iso(String(row.created_at)),
    updatedAt: iso(String(row.updated_at)),
    messageCount: Number(row.message_count ?? 0) * 2,
    lastMessage: typeof row.last_message === 'string' ? row.last_message : null,
  }
}

export class PostgresConversationStore implements ConversationStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 })
  }
  async close() {
    await this.sql.end()
  }

  async create(owner: string, id: string): Promise<Conversation> {
    if (!validConversationId(id))
      throw new ClientError('Use a valid conversation ID.', { code: 'CONVERSATION_ID_INVALID' })
    await this
      .sql`INSERT INTO fast_conversations (id, owner) VALUES (${id}, ${owner.toLowerCase()}) ON CONFLICT (id) DO NOTHING`
    const result = await this.get(owner, id)
    if (!result) throw missing()
    return result
  }

  async list(owner: string, before?: string) {
    const address = owner.toLowerCase()
    if (before && (!validConversationId(before) || !(await this.get(address, before))))
      throw missing()
    const rows = await this.sql`
      SELECT c.*, (SELECT count(*) FROM fast_conversation_turns t WHERE t.conversation_id = c.id) AS message_count,
        (SELECT left(t.reply, 180) FROM fast_conversation_turns t WHERE t.conversation_id = c.id ORDER BY t.created_at DESC, t.turn_id DESC LIMIT 1) AS last_message
      FROM fast_conversations c
      WHERE c.owner = ${address} AND (${before ?? null}::uuid IS NULL OR (c.updated_at, c.id) <
        (SELECT updated_at, id FROM fast_conversations WHERE id = ${before ?? null}::uuid AND owner = ${address}))
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 51`
    return {
      conversations: rows.slice(0, 50).map(summary),
      nextCursor: rows.length > 50 ? String(rows[49]?.id) : null,
    }
  }

  async get(owner: string, id: string): Promise<Conversation | null> {
    if (!validConversationId(id)) return null
    const [row] = await this
      .sql`SELECT * FROM fast_conversations WHERE id = ${id} AND owner = ${owner.toLowerCase()}`
    if (!row) return null
    const turns = await this
      .sql`SELECT t.* FROM fast_conversation_turns t JOIN fast_conversations c ON c.id = t.conversation_id
      WHERE c.id = ${id} AND c.owner = ${owner.toLowerCase()} ORDER BY t.created_at, t.turn_id`
    const messages: ConversationMessage[] = turns.flatMap((turn) => [
      {
        id: `${turn.turn_id}:user`,
        turnId: turn.turn_id,
        role: 'user' as const,
        content: turn.user_content,
        createdAt: iso(turn.created_at),
      },
      {
        id: `${turn.turn_id}:assistant`,
        turnId: turn.turn_id,
        role: 'assistant' as const,
        content: turn.reply,
        createdAt: iso(turn.created_at),
        steps: turn.steps,
        cost: turn.cost,
        status: turn.status,
      },
    ])
    return {
      ...summary(row),
      messages,
      messageCount: messages.length,
      lastMessage: messages.at(-1)?.content.slice(0, 180) ?? null,
    }
  }

  async prepare(owner: string, id: string, messages: readonly InputMessage[]) {
    const conversation = await this.get(owner, id)
    if (!conversation) throw missing()
    validateConversationContext(conversation.messages, messages)
  }

  async record(input: RecordedConversationTurn) {
    const userContent = input.messages.at(-1)?.content
    if (
      typeof userContent !== 'string' ||
      !userContent.trim() ||
      !validConversationId(input.turnId)
    )
      throw new ClientError('A saved turn needs a message and its request ID.', {
        code: 'CONVERSATION_TURN_INVALID',
      })
    await this.sql.begin(async (tx) => {
      const [conversation] =
        await tx`SELECT id FROM fast_conversations WHERE id = ${input.conversationId} AND owner = ${input.owner.toLowerCase()} FOR UPDATE`
      if (!conversation) throw missing()
      const [existing] =
        await tx`SELECT conversation_id, user_content FROM fast_conversation_turns WHERE turn_id = ${input.turnId}`
      if (existing) {
        if (
          existing.conversation_id !== input.conversationId ||
          existing.user_content !== userContent
        )
          throw new ClientError('That turn belongs to a different request.', {
            code: 'CONVERSATION_TURN_CONFLICT',
            statusCode: 409,
          })
        return
      }
      await tx`INSERT INTO fast_conversation_turns (turn_id, conversation_id, user_content, reply, steps, cost, status, created_at)
        VALUES (${input.turnId}, ${input.conversationId}, ${userContent}, ${input.reply}, ${tx.json(JSON.parse(JSON.stringify(input.steps)))}, ${tx.json(input.cost)}, ${input.status},
          coalesce((SELECT created_at FROM assistant_requests WHERE id = ${input.turnId} AND owner = ${input.owner.toLowerCase()}), clock_timestamp()))`
      // A repaired response retains its original request time, even after newer turns.
      await tx`UPDATE fast_conversations SET title =
        (SELECT left(user_content, 100) FROM fast_conversation_turns WHERE conversation_id = ${input.conversationId} ORDER BY created_at, turn_id LIMIT 1),
        updated_at = greatest(created_at, (SELECT max(created_at) FROM fast_conversation_turns WHERE conversation_id = ${input.conversationId})) WHERE id = ${input.conversationId}`
    })
  }
}

/** Same ownership contract for isolated development and non-database route tests. */
export class InMemoryConversationStore implements ConversationStore {
  private conversations = new Map<string, Conversation & { owner: string }>()
  private turns = new Map<string, { conversationId: string; userContent: string }>()
  async close() {}
  async create(owner: string, id: string): Promise<Conversation> {
    if (!validConversationId(id))
      throw new ClientError('Use a valid conversation ID.', { code: 'CONVERSATION_ID_INVALID' })
    if (!this.conversations.has(id)) {
      const now = new Date().toISOString()
      this.conversations.set(id, {
        id,
        owner: owner.toLowerCase(),
        title: 'New conversation',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        lastMessage: null,
        messages: [],
      })
    }
    const result = await this.get(owner, id)
    if (!result) throw missing()
    return result
  }
  async get(owner: string, id: string): Promise<Conversation | null> {
    const result = this.conversations.get(id)
    if (!result || result.owner !== owner.toLowerCase()) return null
    const { owner: _owner, ...conversation } = result
    return structuredClone(conversation)
  }
  async list(owner: string, before?: string) {
    const all = [...this.conversations.values()]
      .filter((item) => item.owner === owner.toLowerCase())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    const start = before ? all.findIndex((item) => item.id === before) + 1 : 0
    if (before && !start) throw missing()
    const rows = all.slice(start, start + 51)
    return {
      conversations: rows
        .slice(0, 50)
        .map(({ owner: _owner, messages: _messages, ...item }) => structuredClone(item)),
      nextCursor: rows.length > 50 ? (rows[49]?.id ?? null) : null,
    }
  }
  async prepare(owner: string, id: string, messages: readonly InputMessage[]) {
    const conversation = await this.get(owner, id)
    if (!conversation) throw missing()
    validateConversationContext(conversation.messages, messages)
  }
  async record(input: RecordedConversationTurn) {
    const conversation = this.conversations.get(input.conversationId)
    if (!conversation || conversation.owner !== input.owner.toLowerCase()) throw missing()
    const userContent = input.messages.at(-1)?.content
    if (
      typeof userContent !== 'string' ||
      !userContent.trim() ||
      !validConversationId(input.turnId)
    )
      throw new ClientError('A saved turn needs a message and its request ID.', {
        code: 'CONVERSATION_TURN_INVALID',
      })
    const old = this.turns.get(input.turnId)
    if (old) {
      if (old.conversationId !== input.conversationId || old.userContent !== userContent)
        throw new ClientError('That turn belongs to a different request.', {
          code: 'CONVERSATION_TURN_CONFLICT',
          statusCode: 409,
        })
      return
    }
    const now = new Date().toISOString()
    this.turns.set(input.turnId, { conversationId: input.conversationId, userContent })
    conversation.messages.push(
      {
        id: `${input.turnId}:user`,
        turnId: input.turnId,
        role: 'user',
        content: userContent,
        createdAt: now,
      },
      {
        id: `${input.turnId}:assistant`,
        turnId: input.turnId,
        role: 'assistant',
        content: input.reply,
        steps: structuredClone(input.steps),
        cost: structuredClone(input.cost),
        status: input.status,
        createdAt: now,
      },
    )
    if (conversation.title === 'New conversation')
      conversation.title = userContent.replace(/\s+/g, ' ').slice(0, 100)
    conversation.messageCount = conversation.messages.length
    conversation.lastMessage = input.reply.slice(0, 180)
    conversation.updatedAt = now
  }
}
