import { NotFoundStage } from '@/components/ui/NotFoundStage'

export default function NotFound() {
  return (
    <div className="bg-canvas relative flex min-h-[100dvh] w-full flex-col overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{
          backgroundImage:
            'linear-gradient(rgb(120 118 112 / 0.13) 1px,transparent 1px),linear-gradient(90deg,rgb(120 118 112 / 0.13) 1px,transparent 1px)',
          backgroundSize: 'var(--aiki-grid) var(--aiki-grid)',
          backgroundPosition: 'center center',
        }}
      />
      <div className="pointer-events-none absolute -right-[100px] -bottom-[120px] z-2 h-[320px] w-[340px] rounded-[48%_52%_44%_56%] bg-[radial-gradient(ellipse_at_40%_40%,rgb(255_77_0_/_0.38),rgb(255_90_20_/_0.24)_45%,rgb(255_120_40_/_0)_72%)] blur-[28px] md:-right-[160px] md:-bottom-[190px] md:h-[520px] md:w-[580px]" />
      <div className="relative z-10 flex flex-1 flex-col">
        <NotFoundStage secondary={{ href: '/docs/getting-started', label: 'Read the docs' }} />
      </div>
    </div>
  )
}
