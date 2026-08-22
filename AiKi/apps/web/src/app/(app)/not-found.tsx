import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
        <div className="max-w-[480px]">
          <span className="text-[17px] font-extrabold tracking-[-0.02em]">
            There is nothing here.
          </span>
          <p className="text-muted mt-[8px] mb-0 text-[13.5px] leading-[1.55] text-pretty">
            The agent or page you asked for is not one we index. If you followed a link from
            somewhere else, the identity behind it may have been transferred or removed.
          </p>
          <Link
            href="/explore"
            className="bg-ink-app hover:bg-orange-app mt-[18px] inline-flex h-[42px] items-center rounded-xl px-[18px] text-[13.5px] font-bold text-white transition-colors"
          >
            Back to agents
          </Link>
        </div>
      </div>
    </div>
  )
}
