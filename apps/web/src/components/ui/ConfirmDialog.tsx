'use client'

/**
 * A confirm that offers the gentler thing people usually meant.
 *
 * Revoking is on-chain, costs gas and cannot be undone; pausing is instant,
 * free and reversible. Most people reaching for "revoke" want "stop now", so
 * the dialog offers both and is honest about which is which rather than making
 * the destructive one the only way forward.
 */
export function ConfirmDialog({
  title,
  body,
  alternative,
  confirmLabel,
  alternativeLabel,
  onConfirm,
  onAlternative,
  onCancel,
}: {
  title: string
  body: string
  alternative: string
  confirmLabel: string
  alternativeLabel: string
  onConfirm: () => void
  onAlternative: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 cursor-default border-0 bg-[rgb(26_26_25_/_0.35)]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-rise relative w-[min(420px,100%)] rounded-[20px] bg-white p-[22px] shadow-[0_40px_90px_-30px_rgb(26_26_25_/_0.5)]"
      >
        <div className="text-[16px] font-extrabold">{title}</div>
        <p className="text-muted mt-[8px] mb-0 text-[13px] leading-[1.55] text-pretty">{body}</p>
        <p className="text-muted mt-[10px] mb-0 text-[13px] leading-[1.55] text-pretty">
          {alternative}
        </p>
        <div className="mt-[18px] flex flex-col gap-[8px] sm:flex-row">
          <button
            type="button"
            onClick={onAlternative}
            className="text-ink-app h-[42px] flex-1 rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
          >
            {alternativeLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-ink-app hover:bg-orange-app h-[42px] flex-1 rounded-xl border-0 text-[13.5px] font-bold text-white transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
