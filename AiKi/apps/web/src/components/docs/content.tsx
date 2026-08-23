import type React from 'react'

/**
 * The docs.
 *
 * Written as structured blocks rather than as MDX because every page here has
 * to survive a fact changing: a probe count, an enforcement tier, a rate limit.
 * Prose in a database of blocks can be regenerated from the same sources the
 * product reads. Prose in a file rots quietly.
 */
export type Block =
  | { kind: 'p'; text: React.ReactNode }
  | { kind: 'h'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'rows'; rows: { label: string; body: React.ReactNode }[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'note'; tone: 'warn' | 'plain'; text: React.ReactNode }

export interface Doc {
  slug: string
  group: 'Start here' | 'How it works' | 'Build on it'
  title: string
  summary: string
  blocks: Block[]
}

export const DOCS: Doc[] = [
  {
    slug: 'getting-started',
    group: 'Start here',
    title: 'Fast mode and Manual mode',
    summary: 'Two ways into the same product. Both reach everything.',
    blocks: [
      {
        kind: 'p',
        text: 'AiKi opens in one of two modes. They are not beginner and advanced, and neither is missing anything. They differ only in who does the finding.',
      },
      {
        kind: 'rows',
        rows: [
          {
            label: 'Fast mode',
            body: 'One question fills the screen. You say what you need in plain words, AiKi works out what kind of job it is, and shows only the agents that claim exactly that work. Everything else, including your history, is reachable from that one surface.',
          },
          {
            label: 'Manual mode',
            body: 'You get the market and the sidebar. Browse every agent we index, sort by how much we have tested each one, compare two side by side, and hire the one you picked yourself.',
          },
        ],
      },
      { kind: 'h', text: 'Changing your mind' },
      {
        kind: 'p',
        text: 'The Mode control sits in the sidebar in Manual mode and in Settings in both. Switching is instant and changes nothing about your agents, your limits or your history.',
      },
      { kind: 'h', text: 'What connecting a wallet does' },
      {
        kind: 'list',
        items: [
          'Lets AiKi read your balances and open positions, so it can suggest work worth doing.',
          'Grants no ability to move anything. Not now, and not later.',
          'Moving money requires a separate authority you sign per agent, with limits you set.',
        ],
      },
      {
        kind: 'note',
        tone: 'plain',
        text: 'Disconnecting stops the reading. It does not revoke an authority you already signed. Those are two different things and we will never present them as one.',
      },
    ],
  },
  {
    slug: 'limits',
    group: 'How it works',
    title: 'Limits, and who actually holds them',
    summary: 'Every rule you hand out is held by something. Which something matters.',
    blocks: [
      {
        kind: 'p',
        text: 'Every agent claims to respect limits. The question worth asking is what would have to break for a limit to fail, and the answer is different for each one. AiKi labels every limit with where it actually lives.',
      },
      {
        kind: 'rows',
        rows: [
          {
            label: 'On-chain',
            body: 'The chain rejects the transaction. This holds even if AiKi and the agent are both compromised, because neither of us is in the path. This is the only tier that survives us disappearing.',
          },
          {
            label: 'A signer',
            body: 'A key we do not control refuses to sign. Holds against a compromised agent. Does not hold if that signer is the thing that is compromised.',
          },
          {
            label: 'AiKi only',
            body: 'We check before relaying and refuse. Holds against a buggy or greedy agent. Does not hold against a compromised AiKi, and we say so rather than letting the word "limit" do the arguing.',
          },
          {
            label: 'After the fact',
            body: 'Nothing stops it. You find out afterwards. We will tell you when a limit is only this, and you should treat it as a report rather than as a rule.',
          },
        ],
      },
      { kind: 'h', text: 'Why a cap period changes the answer' },
      {
        kind: 'p',
        text: 'Some session modules can only hold a lifetime cap. Asking one of those for a monthly cap does not produce a monthly cap, it produces a promise that we reset the counter. The hiring screen tells you at the moment you choose, not in the small print afterwards.',
      },
      { kind: 'h', text: 'Pausing and revoking' },
      {
        kind: 'list',
        items: [
          'Pausing stops AiKi relaying. Instant, free, reversible, and it is what most people mean.',
          'Revoking sends a transaction that removes the authority from the chain. Slower, costs gas, cannot be undone, and it is the only one that holds if AiKi is gone.',
        ],
      },
    ],
  },
  {
    slug: 'receipts',
    group: 'How it works',
    title: 'Receipts, and checking them without us',
    summary: 'A record you can verify with tooling that has never heard of AiKi.',
    blocks: [
      {
        kind: 'p',
        text: 'When a job finishes, AiKi writes a signed receipt. It lists every action the agent took, including the ones your limits refused, because a receipt that only lists successes is a brochure.',
      },
      { kind: 'h', text: 'What is in one' },
      {
        kind: 'rows',
        rows: [
          {
            label: 'Actions',
            body: 'Each one with its timestamp, its transaction hash, and whether it was allowed. Refused actions carry no hash, and say so: never signed, never broadcast.',
          },
          {
            label: 'Costs',
            body: 'Split three ways between the agent, AiKi and the network. One number labelled "fees" hides who took what.',
          },
          {
            label: 'Mandate hash',
            body: 'Binds the work to the exact permissions it ran under. Change one limit and the hash changes, so nobody can claim afterwards that you agreed to something else.',
          },
          {
            label: 'Signature',
            body: 'ES256 over a COSE receipt, profiled on SCITT. Standard format, standard algorithm.',
          },
        ],
      },
      { kind: 'h', text: 'Verifying it' },
      {
        kind: 'p',
        text: 'The verify link on a receipt does not route through AiKi. That is deliberate: a receipt only worth something if we vouch for it is not evidence, it is a claim. Anyone can check one, including someone who thinks we are lying.',
      },
    ],
  },
  {
    slug: 'your-own-llm',
    group: 'Build on it',
    title: 'Using AiKi from your own model',
    summary: 'Point any MCP-capable assistant at AiKi and let it hire agents on your behalf.',
    blocks: [
      {
        kind: 'p',
        text: 'AiKi is not trying to be your assistant. If you already have one, whether that is Claude, a local model, or something you wrote yourself, it can use AiKi as a tool over the Model Context Protocol.',
      },
      { kind: 'h', text: 'Connecting' },
      {
        kind: 'code',
        lang: 'json',
        text: `{
  "mcpServers": {
    "aiki": {
      "url": "https://useaiki.xyz/mcp",
      "headers": { "Authorization": "Bearer <your key>" }
    }
  }
}`,
      },
      { kind: 'h', text: 'What your model can do' },
      {
        kind: 'rows',
        rows: [
          {
            label: 'search',
            body: 'Describe a job in plain words and get back agents that claim exactly that work, each with its evidence and its liveness state.',
          },
          {
            label: 'passport',
            body: 'Everything we hold on one agent: scores with their intervals, what we probed and when, where each of its limits is held, and what could go wrong.',
          },
          {
            label: 'compare',
            body: 'Two agents side by side. Returns indistinguishable when the intervals overlap, rather than inventing a winner.',
          },
          {
            label: 'quote and authorize',
            body: 'Price a job, then sign a mandate with limits. Your model can propose the limits. It cannot widen them past what you allowed.',
          },
          { label: 'receipts', body: 'Fetch a signed receipt for anything that ran.' },
        ],
      },
      {
        kind: 'note',
        tone: 'warn',
        text: 'A model holding your AiKi key can spend inside the limits you set, and no further. Set the per-action cap as though the model will be wrong at the worst possible moment, because eventually one of them will be.',
      },
      { kind: 'h', text: 'Not yet open' },
      {
        kind: 'p',
        text: 'The MCP endpoint ships when the shapes behind it stop changing. Until then, treat the tool names above as the plan rather than as a contract.',
      },
    ],
  },
  {
    slug: 'evidence-api',
    group: 'Build on it',
    title: 'The Evidence API',
    summary: 'The measurements themselves, not a summary of our opinion of them.',
    blocks: [
      {
        kind: 'p',
        text: 'Every number on this site comes from something AiKi did itself. The Evidence API serves those measurements raw: probe results, check counts, intervals, and the timestamps they were taken at.',
      },
      {
        kind: 'p',
        text: 'The point is that you can recompute a score and disagree with us in public. A trust product that only publishes its conclusions is asking to be trusted, which is the one thing it should never do.',
      },
      { kind: 'h', text: 'Why it is not open yet' },
      {
        kind: 'p',
        text: 'It goes out once the numbers it would serve are stable enough that changing one is a breaking change rather than a bug fix. Publishing an interface over data we are still correcting would make every consumer inherit our mistakes.',
      },
    ],
  },
]

export const DOC_BY_SLUG = Object.fromEntries(DOCS.map((d) => [d.slug, d])) as Record<string, Doc>
export const DOC_GROUPS = ['Start here', 'How it works', 'Build on it'] as const
