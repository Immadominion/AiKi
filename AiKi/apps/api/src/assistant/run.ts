import Anthropic from '@anthropic-ai/sdk'
import { pointsFor, type Usage } from '../credits/pricing.js'
import { MUTATING, runTool, TOOLS, type ToolContext } from './tools.js'

/**
 * Fast mode: the model driving AiKi's own tools.
 *
 * The loop is ordinary — ask, run whatever tools were called, ask again — and
 * the two things worth knowing about it are both about honesty.
 *
 * Usage is summed across every request in the turn, not just the last one. A
 * question that takes four tool calls costs four model calls, and charging for
 * one of them would mean the expensive questions are the ones AiKi loses money
 * on. The count is the provider's, not an estimate.
 *
 * Every tool the model ran is returned alongside the answer. Fast mode is the
 * same surface as Manual mode with a model at the controls, and somebody who
 * cannot see which controls were touched has been given a chatbot instead of an
 * agent they can supervise.
 */

const MAX_ROUNDS = 8

/**
 * The system prompt and the tool schemas, which are sent on every round and are
 * not in the message list. Rounded generously upward: this number is only ever
 * used to decide whether there is enough money left for one more round, and
 * under-counting there is how a turn costs more than was held for it.
 */
const OVERHEAD_TOKENS = 3_000

/**
 * The most one more round could possibly cost, from the conversation as it
 * stands.
 *
 * Deliberately an over-estimate, on both terms. Three characters per token is
 * pessimistic for JSON, which usually runs nearer four, and the output is
 * counted at the full ceiling the request allows even though almost every round
 * writes a fraction of it. A turn stops when this says the next round might not
 * fit, so the money held for a turn is a ceiling it cannot pass rather than a
 * figure it is compared against afterwards.
 */
function roundCeiling(
  model: string,
  messages: Anthropic.MessageParam[],
  maxTokens: number,
): number {
  const inputTokens = Math.ceil(JSON.stringify(messages).length / 3) + OVERHEAD_TOKENS
  return pointsFor(model, { inputTokens, outputTokens: maxTokens })
}

export interface AssistantStep {
  tool: string
  input: Record<string, unknown>
  ok: boolean
  mutating: boolean
}

export interface AssistantTurn {
  reply: string
  steps: AssistantStep[]
  usage: Usage
  points: number
  model: string
  /** True when the model was still working and hit the ceiling. */
  truncated: boolean
  /** Which ceiling, when it hit one. Absent when the model finished. */
  stoppedBy?: 'rounds' | 'budget'
}

export const SYSTEM = `You are AiKi's Fast mode. AiKi is an agent marketplace on BNB Smart Chain
that measures agents rather than listing them, and puts contract-enforced limits on what a hired
agent may spend.

You are driving the same API the website's Manual mode uses, with the person's own session. You can
do what they could do by clicking, and nothing more. When a route refuses you, it refuses them too;
relay its sentence rather than paraphrasing it away.

How to be useful here:

- Lead with what was measured. Every score has a sample size — always give it. Most of the registry
  has never answered a probe, so a missing score is normal and is not a failure.
- Never say an agent is "best" or "recommended". Say what was measured and let them decide. This is
  a marketplace and you have an incentive to rank things; do not.
- A limit is only worth what enforces it. A signed mandate is held by a contract that refuses
  anything outside it. An unsigned one is counted by AiKi. Both are real, they fail differently, and
  you must never describe an unsigned mandate as protected by the chain.
- You cannot sign anything. Signing needs their wallet. After creating a mandate, tell them it needs
  signing and what that changes.
- Before putting an agent on duty, ask. It is the only thing here that moves money while nobody is
  watching, and that is exactly why it should be a decision rather than a side effect.
- Searching matches agent NAMES, and names in this registry rarely say what an agent does. A miss
  means nothing is named that. Say so instead of concluding none exist.

Everything is BNB testnet, against enforcer contracts that have not been audited. Be brief and
concrete. Amounts in USDT, and say what a thing costs before doing it.`

export interface RunInput {
  apiKey: string
  model: string
  ctx: ToolContext
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  /**
   * The most this turn may cost, in points, already taken from the buyer.
   *
   * Enforced here rather than checked afterwards. The route used to gate on a
   * balance and settle later with whatever was left, which meant a turn could
   * cost more than the person had and the difference was quietly written off.
   */
  budgetPoints?: number
}

export async function runAssistant(input: RunInput): Promise<AssistantTurn> {
  const client = new Anthropic({ apiKey: input.apiKey })
  const messages: Anthropic.MessageParam[] = [...input.messages]
  const steps: AssistantStep[] = []
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let truncated = true

  const maxTokens = input.maxTokens ?? 1500
  for (let round = 0; round < MAX_ROUNDS; round++) {
    /*
     * Asked before the request, not after. Checking afterwards would mean the
     * round that broke the budget had already been paid for at the provider.
     */
    if (
      input.budgetPoints !== undefined &&
      pointsFor(input.model, usage) + roundCeiling(input.model, messages, maxTokens) >
        input.budgetPoints
    )
      return {
        reply:
          'I stopped here because this answer was about to cost more than the points held for it. Here is what I found before stopping. Ask me to continue and I will pick it up with a fresh budget.',
        steps,
        usage,
        points: pointsFor(input.model, usage),
        model: input.model,
        truncated: true,
        stoppedBy: 'budget',
      }

    const response = await client.messages.create({
      model: input.model,
      max_tokens: maxTokens,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    })

    // Summed every round: the provider charges for each request, so charging for
    // one would make the expensive questions the ones AiKi loses money on.
    usage.inputTokens += response.usage.input_tokens
    usage.outputTokens += response.usage.output_tokens

    const calls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )
    if (calls.length === 0) {
      truncated = false
      const reply = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      return {
        reply,
        steps,
        usage,
        points: pointsFor(input.model, usage),
        model: input.model,
        truncated,
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const call of calls) {
      const args = (call.input ?? {}) as Record<string, unknown>
      const out = await runTool(input.ctx, call.name, args)
      steps.push({ tool: call.name, input: args, ok: out.ok, mutating: MUTATING.has(call.name) })
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        // A refusal goes back as content rather than an error, so the model can
        // explain it and offer the fix instead of stalling.
        is_error: !out.ok,
        content: JSON.stringify(out.body ?? null).slice(0, 20_000),
      })
    }
    messages.push({ role: 'user', content: results })
  }

  return {
    reply:
      'That turned into more steps than one answer should take, so I stopped. Here is what I did before stopping. Ask me to continue and I will pick it up.',
    steps,
    usage,
    stoppedBy: 'rounds',
    points: pointsFor(input.model, usage),
    model: input.model,
    truncated,
  }
}
