import { messageBlocks, messageInlines } from './fast-message'

function Inline({ text }: { text: string }) {
  return messageInlines(text).map((part) => {
    switch (part.kind) {
      case 'strong':
        return <strong key={part.offset}>{part.text}</strong>
      case 'em':
        return <em key={part.offset}>{part.text}</em>
      case 'code':
        return (
          <code key={part.offset} className="rounded bg-black/5 px-1 py-0.5 text-[0.92em]">
            {part.text}
          </code>
        )
      case 'link':
        return (
          <a
            key={part.offset}
            href={part.href}
            {...(part.href?.startsWith('http')
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
            className="font-semibold underline decoration-black/25 underline-offset-[3px] hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {part.text}
          </a>
        )
      default:
        return <span key={part.offset}>{part.text}</span>
    }
  })
}

export function FastMessage({ text }: { text: string }) {
  return (
    <div className="space-y-[10px] text-[13px] leading-[1.65] [overflow-wrap:anywhere]">
      {messageBlocks(text).map((block) => {
        if (block.kind === 'code')
          return (
            <pre
              key={block.offset}
              className="overflow-x-auto rounded-xl bg-black/5 p-3 text-[12px]"
            >
              <code>{block.text}</code>
            </pre>
          )
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul'
          return (
            <List
              key={block.offset}
              {...(block.ordered ? { start: block.start } : {})}
              className={`space-y-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
            >
              {block.items.map((item, index) => (
                // Items are immutable within a completed assistant message.
                // biome-ignore lint/suspicious/noArrayIndexKey: Position identifies repeated list text.
                <li key={index}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          )
        }
        return (
          <p
            key={block.offset}
            className={`m-0 whitespace-pre-wrap ${block.kind === 'heading' ? 'font-bold' : ''}`}
          >
            <Inline text={block.text} />
          </p>
        )
      })}
    </div>
  )
}
