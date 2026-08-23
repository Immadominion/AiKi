import { HowWeTestBody } from '@/components/evidence/HowWeTest'
import { type Block, DOC_BY_SLUG } from './content'

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${b.kind}-${i}`
        if (b.kind === 'h')
          return (
            <h2 key={key} className="mt-[28px] mb-[8px] text-[16px] font-bold first:mt-0">
              {b.text}
            </h2>
          )
        if (b.kind === 'p')
          return (
            <p
              key={key}
              className="mt-0 mb-[14px] text-[14px] leading-[1.7] text-pretty text-[#3D3D3A]"
            >
              {b.text}
            </p>
          )
        if (b.kind === 'list')
          return (
            <ul key={key} className="mt-0 mb-[14px] flex list-none flex-col gap-[9px] p-0">
              {b.items.map((it) => (
                <li
                  key={it}
                  className="flex items-start gap-[10px] text-[14px] leading-[1.65] text-pretty text-[#3D3D3A]"
                >
                  <span className="mt-[9px] size-[5px] flex-none rounded-full bg-[#FF4D00]" />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          )
        if (b.kind === 'rows')
          return (
            <div
              key={key}
              className="mb-[18px] overflow-hidden rounded-[18px] border border-[rgb(20_20_20_/_0.08)] bg-white"
            >
              {b.rows.map((r) => (
                <div
                  key={r.label}
                  className="flex flex-col items-start gap-1 border-t border-[rgb(20_20_20_/_0.06)] px-[16px] py-[14px] first:border-t-0 sm:flex-row sm:gap-4"
                >
                  <span className="w-full flex-none text-[13px] font-bold sm:w-[156px]">
                    {r.label}
                  </span>
                  <span className="min-w-0 flex-1 text-[13.5px] leading-[1.65] text-pretty text-[#3D3D3A]">
                    {r.body}
                  </span>
                </div>
              ))}
            </div>
          )
        if (b.kind === 'code')
          return (
            <pre
              key={key}
              className="mb-[18px] overflow-x-auto rounded-[16px] bg-[#141414] px-[16px] py-[15px] font-mono text-[12.5px] leading-[1.75] text-white/85"
            >
              <code>{b.text}</code>
            </pre>
          )
        return (
          <div
            key={key}
            className="mb-[18px] flex items-start gap-[10px] rounded-[15px] px-[15px] py-[13px]"
            style={{
              background: b.tone === 'warn' ? 'var(--color-warn-hi-bg)' : 'rgb(20 20 20 / 0.035)',
            }}
          >
            <span
              className="mt-px flex size-[19px] flex-none items-center justify-center rounded-[7px] text-[11px] font-extrabold"
              style={
                b.tone === 'warn'
                  ? { background: 'var(--color-warn-hi)', color: '#141414' }
                  : { background: 'rgb(20 20 20 / 0.12)', color: '#57574F' }
              }
            >
              {b.tone === 'warn' ? '!' : 'i'}
            </span>
            <span
              className="text-[13px] leading-[1.65] text-pretty"
              style={{ color: b.tone === 'warn' ? 'var(--color-warn-hi-ink)' : '#57574F' }}
            >
              {b.text}
            </span>
          </div>
        )
      })}
    </>
  )
}

export function DocsArticle({ slug }: { slug: string }) {
  const isEvidence = slug === 'how-we-test'
  const doc = DOC_BY_SLUG[slug]

  const title = isEvidence ? 'How we test' : (doc?.title ?? 'Not a page')
  const summary = isEvidence
    ? 'Every number on this site comes from something AiKi did itself.'
    : (doc?.summary ?? 'Nothing lives at that address. Pick something from the contents instead.')

  return (
    <article className="max-w-[760px]">
      <h1 className="mt-0 mb-[6px] text-[clamp(24px,3.4vw,32px)] leading-[1.1] font-extrabold tracking-[-0.03em] text-balance">
        {title}
      </h1>
      <p className="mt-0 mb-[26px] text-[14.5px] leading-[1.55] text-pretty text-[#767676]">
        {summary}
      </p>
      {isEvidence ? <HowWeTestBody /> : doc ? <Blocks blocks={doc.blocks} /> : null}
    </article>
  )
}
