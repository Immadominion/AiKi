import { ClientError } from '../http/errors.js'

export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string
}

export function assistantMessages(value: unknown): AssistantMessage[] {
  if (!Array.isArray(value) || !value.length)
    throw new ClientError('Send at least one message.', { code: 'ASSISTANT_NO_MESSAGES' })
  if (value.length > 100 || JSON.stringify(value).length > 8000)
    throw new ClientError('That conversation is too long to send in one turn. Start a new one.', {
      code: 'ASSISTANT_TOO_LONG',
    })
  const messages = value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new ClientError('Fast mode accepts text messages only.', {
        code: 'ASSISTANT_INVALID_MESSAGES',
      })
    const item = entry as Record<string, unknown>
    if (
      !['user', 'assistant'].includes(String(item.role)) ||
      typeof item.content !== 'string' ||
      !item.content.trim() ||
      Object.keys(item).some((key) => !['role', 'content'].includes(key))
    )
      throw new ClientError('Fast mode accepts user and assistant text messages only.', {
        code: 'ASSISTANT_INVALID_MESSAGES',
      })
    return { role: item.role as AssistantMessage['role'], content: item.content }
  })
  if (messages.at(-1)?.role !== 'user')
    throw new ClientError('End the conversation with your message.', {
      code: 'ASSISTANT_INVALID_MESSAGES',
    })
  return messages
}
