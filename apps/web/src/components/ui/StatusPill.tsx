export type Tone = 'good' | 'work' | 'idle' | 'warn'

const TONES: Record<Tone, { bg: string; dot: string; fg: string }> = {
  good: { bg: 'var(--color-good-bg)', dot: 'var(--color-good)', fg: 'var(--color-good-ink)' },
  work: { bg: 'var(--color-work-bg)', dot: 'var(--color-work)', fg: 'var(--color-work-ink)' },
  idle: { bg: 'rgb(26 26 25 / 0.05)', dot: 'var(--color-muted)', fg: 'var(--color-muted)' },
  warn: { bg: 'var(--color-warn-bg)', dot: 'var(--color-warn)', fg: 'var(--color-warn-ink)' },
}

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const t = TONES[tone]
  return (
    <span
      className="inline-flex items-center gap-[7px] rounded-full py-[5px] pr-[11px] pl-[9px]"
      style={{ background: t.bg }}
    >
      <span className="size-[6px] flex-none rounded-full" style={{ background: t.dot }} />
      <span className="text-[12.5px] font-bold whitespace-nowrap" style={{ color: t.fg }}>
        {label}
      </span>
    </span>
  )
}
