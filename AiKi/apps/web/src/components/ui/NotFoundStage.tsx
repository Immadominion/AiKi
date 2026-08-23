'use client'

import { RuntimeLoader, useRive } from '@rive-app/react-canvas'
import Link from 'next/link'
import { route } from '@/lib/routes'

/**
 * The 404.
 *
 * A dead link is the one moment where being playful costs nothing: nobody is
 * mid-transaction, nothing is at stake, and the only useful thing we can do is
 * be clear about what happened and hand back a door. So the animation carries
 * the mood and the copy stays honest underneath it.
 */
// The runtime fetches its wasm from unpkg by default. A 404 page is exactly
// where you do not want a third-party CDN in the path, so it is served locally.
RuntimeLoader.setWasmUrl('/rive.wasm')

export function NotFoundStage({
  title = 'This page went and got itself lost',
  body = 'No agent was harmed. Nothing was spent. Whatever you were looking for either moved, never existed, or belonged to an identity that has since changed hands.',
  primary = { href: '/', label: 'Back to AiKi' },
  secondary,
}: {
  title?: string
  body?: string
  primary?: { href: string; label: string }
  secondary?: { href: string; label: string }
}) {
  const { RiveComponent } = useRive({
    src: '/404.riv',
    autoplay: true,
    // The file ships one artboard; naming it would break if the file is
    // replaced, and the default is the right one either way.
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-10 text-center">
      <div className="pointer-events-none h-[min(46vh,300px)] w-[min(92vw,520px)]">
        <RiveComponent className="h-full w-full" />
      </div>

      <h1 className="mt-[6px] mb-0 max-w-[560px] text-[clamp(22px,4vw,30px)] leading-[1.1] font-extrabold tracking-[-0.03em] text-balance">
        {title}
      </h1>
      <p className="text-muted mt-[10px] mb-0 max-w-[520px] text-[13.5px] leading-[1.6] text-pretty">
        {body}
      </p>

      <div className="mt-[22px] flex flex-wrap items-center justify-center gap-[8px]">
        <Link
          href={route(primary.href)}
          className="bg-ink-app hover:bg-orange-app flex h-[42px] items-center rounded-xl px-[18px] text-[13.5px] font-bold text-white transition-colors"
        >
          {primary.label}
        </Link>
        {secondary ? (
          <Link
            href={route(secondary.href)}
            className="text-ink-app flex h-[42px] items-center rounded-xl bg-[rgb(26_26_25_/_0.055)] px-[18px] text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
          >
            {secondary.label}
          </Link>
        ) : null}
      </div>
    </div>
  )
}
