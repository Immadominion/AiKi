import { BanknoteIcon, ChevronRightIcon, EyeIcon, GaugeIcon } from 'lucide-react'
import type { AgentDetail } from '@/lib/detail'

function Step({
  number,
  label,
  title,
  detail,
  icon,
  action,
}: {
  number: string
  label: string
  title: string
  detail: string
  icon: React.ReactNode
  action?: boolean
}) {
  return (
    <div className="relative z-1 grid min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-2 px-1.5 py-1.5 sm:px-2">
      <span
        className={`grid size-8 place-items-center rounded-[10px_10px_14px_10px] border ${
          action
            ? 'border-orange-app bg-orange-app text-white'
            : 'border-[rgb(26_26_25_/_0.1)] bg-[rgb(255_255_255_/_0.78)] text-ink-app'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <small className="text-faint block text-[6px] font-bold tracking-[0.09em] uppercase">
          {number} · {label}
        </small>
        <b className="mt-0.5 block truncate text-[10px]">{title}</b>
        <span className="text-muted mt-0.5 block truncate text-[7px]">{detail}</span>
      </span>
    </div>
  )
}

function Connector() {
  return (
    <span className="text-faint hidden items-center min-[560px]:flex" aria-hidden>
      <span className="h-px flex-1 bg-[rgb(26_26_25_/_0.2)]" />
      <ChevronRightIcon size={11} strokeWidth={1.6} className="-ml-1" />
    </span>
  )
}

export function AgentOperationFlow({ detail }: { detail: AgentDetail }) {
  const observe = detail.capabilities[0]
  const act = detail.capabilities.at(-1)

  if (!observe || !act) return null

  return (
    <section
      aria-label="Agent operating flow"
      className="relative mb-3 grid overflow-hidden rounded-[22px_22px_48px_22px] bg-[#f4f3ef] px-2 py-2 min-[560px]:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1fr)] min-[560px]:items-center"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-[116px] -right-[98px] size-[180px] rounded-full border border-[rgb(255_90_0_/_0.18)]"
      />
      <Step
        number="01"
        label="Observe"
        title={observe.name}
        detail={observe.permissions.join(' · ')}
        icon={<EyeIcon aria-hidden size={15} strokeWidth={1.9} />}
      />
      <Connector />
      <Step
        number="02"
        label="Decide"
        title="Evaluate your rule"
        detail="No spend while checking"
        icon={<GaugeIcon aria-hidden size={15} strokeWidth={1.9} />}
      />
      <Connector />
      <Step
        number="03"
        label="Act"
        title={act.name}
        detail={act.permissions.join(' · ')}
        icon={
          detail.spends.length > 0 ? (
            <BanknoteIcon aria-hidden size={15} strokeWidth={1.9} />
          ) : (
            <EyeIcon aria-hidden size={15} strokeWidth={1.9} />
          )
        }
        action
      />
    </section>
  )
}
