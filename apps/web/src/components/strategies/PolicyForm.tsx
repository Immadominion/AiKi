'use client'

import type { StrategyKind, StrategySetupInput } from '@aiki/contracts/strategies'
import type { FormEvent } from 'react'
import {
  displayPolicyValue,
  emptyRung,
  type GridRungForm,
  POLICY_FIELDS,
  type StrategyField,
  type StrategyFormValues,
} from './policy'

export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app'
export const PRIMARY = `min-h-11 cursor-pointer rounded-xl border border-ink-app bg-ink-app px-4 py-2 text-sm font-bold text-surface disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`
export const SECONDARY = `min-h-11 cursor-pointer rounded-xl border border-ink-app/15 bg-surface px-4 py-2 text-sm font-semibold text-ink-app hover:bg-surface-sunk disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`
export const INPUT = `min-h-11 w-full min-w-0 rounded-xl border border-ink-app/20 bg-surface px-3 py-2 text-base text-ink-app sm:text-sm ${FOCUS}`
export const PANEL = 'min-w-0 rounded-2xl border border-ink-app/10 bg-surface p-4 sm:p-5'

export function AmountField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  mode = 'decimal',
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  error?: string
  mode?: 'decimal' | 'numeric' | 'text'
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={`strategy-${id}`} className="block text-sm font-semibold">
        {label} <span className="text-muted text-xs">(required)</span>
      </label>
      <input
        id={`strategy-${id}`}
        type="text"
        inputMode={mode}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT}
        aria-invalid={error ? true : undefined}
        aria-required="true"
        aria-describedby={error ? `strategy-${id}-error` : hint ? `strategy-${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`strategy-${id}-hint`} className="text-muted m-0 text-xs leading-relaxed">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`strategy-${id}-error`} role="alert" className="text-work-ink m-0 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function PolicyForm({
  kind,
  values,
  rungs,
  onValues,
  onRungs,
  onSubmit,
  busy,
  blocked,
  problem,
}: {
  kind: StrategyKind
  values: StrategyFormValues
  rungs: GridRungForm[]
  onValues: (values: StrategyFormValues) => void
  onRungs: (rungs: GridRungForm[]) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  busy: boolean
  blocked: boolean
  problem?: { field: string; message: string } | undefined
}) {
  const field = (f: StrategyField) => (
    <AmountField
      key={f.key}
      id={f.key}
      label={`${f.label} (${f.unit})`}
      value={values[f.key] ?? ''}
      onChange={(value) => onValues({ ...values, [f.key]: value })}
      hint={f.hint}
      mode={f.unit === 'USDT' || f.unit === 'WBNB' ? 'decimal' : f.negative ? 'text' : 'numeric'}
      {...(problem?.field === f.key ? { error: problem.message } : {})}
    />
  )
  const advanced = POLICY_FIELDS[kind].filter((f) => f.advanced)
  return (
    <form onSubmit={onSubmit} aria-busy={busy} className="space-y-4">
      <fieldset disabled={busy} className={`${PANEL} m-0 space-y-5`}>
        <legend className="sr-only">Immutable strategy policy</legend>
        <div>
          <h2 className="m-0 text-base font-bold">Set your limits</h2>
          <p className="text-muted mt-1 mb-0 text-sm leading-relaxed">
            These limits cannot be edited after deployment. A different policy requires a separate
            vault.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {POLICY_FIELDS[kind].filter((f) => !f.advanced).map(field)}
        </div>
        {kind === 'grid' ? (
          <fieldset className="m-0 min-w-0 space-y-3 rounded-xl border border-ink-app/10 p-3 sm:p-4">
            <legend className="px-1 text-sm font-bold">Grid rungs · USDT / WBNB</legend>
            <p className="text-muted m-0 text-xs leading-relaxed">
              Pool ticks quote WBNB per USDT, not BNB’s dollar price. Buy-USDT and sell-USDT
              thresholds are shown explicitly. The first observation never trades a historical
              crossing.
            </p>
            {rungs.map((rung, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: indexed immutable-policy slots use fully controlled inputs, never child state.
              <div key={`rung-${index + 1}`} className="space-y-3 border-t border-ink-app/10 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 flex-1 text-sm font-bold">Rung {index + 1}</h3>
                  <button
                    type="button"
                    className={SECONDARY}
                    disabled={rungs.length === 1}
                    onClick={() => onRungs(rungs.filter((_, i) => i !== index))}
                  >
                    Remove rung {index + 1}
                  </button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ['buyTick', 'Buy-USDT tick (sell WBNB)'],
                      ['sellTick', 'Sell-USDT tick (buy WBNB)'],
                      ['lot0', 'USDT per rung trade'],
                      ['lot1', 'WBNB per rung trade'],
                    ] as const
                  ).map(([key, label]) => (
                    <AmountField
                      key={key}
                      id={`rung-${index}-${key}`}
                      label={label}
                      value={rung[key]}
                      mode={key.endsWith('Tick') ? 'text' : 'decimal'}
                      onChange={(value) =>
                        onRungs(rungs.map((r, i) => (i === index ? { ...r, [key]: value } : r)))
                      }
                      {...(problem?.field === `rung-${index}-${key}`
                        ? { error: problem.message }
                        : {})}
                    />
                  ))}
                </div>
                <label
                  className="block text-sm font-semibold"
                  htmlFor={`strategy-rung-${index}-direction`}
                >
                  First trade direction
                </label>
                <select
                  id={`strategy-rung-${index}-direction`}
                  className={INPUT}
                  value={rung.initialSell ? 'sell' : 'buy'}
                  onChange={(event) =>
                    onRungs(
                      rungs.map((r, i) =>
                        i === index ? { ...r, initialSell: event.target.value === 'sell' } : r,
                      ),
                    )
                  }
                >
                  <option value="sell">USDT → WBNB</option>
                  <option value="buy">WBNB → USDT</option>
                </select>
              </div>
            ))}
            <button
              type="button"
              className={SECONDARY}
              disabled={rungs.length >= 32}
              onClick={() => onRungs([...rungs, emptyRung()])}
            >
              Add rung
            </button>
          </fieldset>
        ) : null}
        <details
          className="group rounded-xl border border-ink-app/10 p-3 sm:p-4"
          {...(problem && advanced.some((f) => f.key === problem.field) ? { open: true } : {})}
        >
          <summary
            className={`flex min-h-10 cursor-pointer items-center text-sm font-bold ${FOCUS}`}
          >
            <span className="flex-1">Advanced allocation and execution limits</span>
            <span aria-hidden="true" className="ml-3 text-lg group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">{advanced.map(field)}</div>
        </details>
        <div className="grid gap-5 sm:grid-cols-2">
          {(
            [
              [
                'days',
                'Policy duration (days)',
                'Expiry blocks automation, never owner recovery.',
                'numeric',
              ],
              [
                'minInterval',
                'Minimum interval (seconds)',
                'No automatic operation can execute sooner than this interval.',
                'numeric',
              ],
              [
                'maxDeadlineDelay',
                'Transaction deadline limit (seconds)',
                'Maximum age of an operation deadline; at most 3600 seconds.',
                'numeric',
              ],
              [
                'gasLimitBnb',
                'Maximum network gas per operation (BNB)',
                'Maximum 0.001 BNB. A gas ceiling, not a charge; separate from invested capital and AiKi points.',
                'decimal',
              ],
            ] as const
          ).map(([key, label, hint, mode]) => (
            <AmountField
              key={key}
              id={key}
              label={label}
              hint={hint}
              mode={mode}
              value={values[key] ?? ''}
              onChange={(value) => onValues({ ...values, [key]: value })}
              {...(problem?.field === key ? { error: problem.message } : {})}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={PRIMARY} disabled={busy || blocked}>
          {busy ? 'Preparing your review…' : 'Review deployment and policy'}
        </button>
        <span className="text-muted max-w-prose text-xs">
          This prepares a review only. It does not deploy, fund, sign or start anything.
        </span>
      </div>
    </form>
  )
}

export function PolicyReview({ input }: { input: StrategySetupInput }) {
  return (
    <details className={`${PANEL} group`}>
      <summary className={`flex min-h-10 cursor-pointer items-center text-sm font-bold ${FOCUS}`}>
        <span className="flex-1">Review all immutable limits</span>
        <span aria-hidden="true" className="ml-3 text-lg group-open:rotate-90">
          ›
        </span>
      </summary>
      <dl className="mt-3 space-y-3 text-sm">
        {POLICY_FIELDS[input.kind].map((field) => (
          <div
            key={field.key}
            className="grid min-w-0 gap-1 border-t border-ink-app/10 pt-3 sm:grid-cols-2"
          >
            <dt className="text-body">{field.label}</dt>
            <dd className="m-0 min-w-0 break-words font-semibold tabular-nums">
              {displayPolicyValue(
                field,
                (input.policy as unknown as Record<string, unknown>)[field.key],
              )}
            </dd>
          </div>
        ))}
        <div className="grid gap-1 border-t border-ink-app/10 pt-3 sm:grid-cols-2">
          <dt className="text-body">Expiry (UTC)</dt>
          <dd className="m-0 break-all font-semibold">
            {Number.isFinite(new Date(Number(input.common.expiresAt) * 1000).getTime())
              ? new Date(Number(input.common.expiresAt) * 1000).toISOString()
              : `${input.common.expiresAt} Unix seconds`}
          </dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          <dt className="text-body">Minimum interval</dt>
          <dd className="m-0 font-semibold">{input.common.minInterval} seconds</dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          <dt className="text-body">Maximum deadline delay</dt>
          <dd className="m-0 font-semibold">{input.common.maxDeadlineDelay} seconds</dd>
        </div>
      </dl>
      {input.kind === 'grid' ? (
        <div className="mt-4 space-y-2">
          {input.rungs.map((rung, i) => (
            <p
              key={`${rung.buyTick}:${rung.sellTick}`}
              className="text-body m-0 break-words text-xs leading-relaxed"
            >
              Rung {i + 1}: buy USDT at tick {rung.buyTick}; sell USDT at tick {rung.sellTick}. Lot
              limits: {displayPolicyValue({ unit: 'USDT' } as StrategyField, rung.lot0)} /{' '}
              {displayPolicyValue({ unit: 'WBNB' } as StrategyField, rung.lot1)}. First direction:{' '}
              {rung.initialSell ? 'USDT → WBNB' : 'WBNB → USDT'}.
            </p>
          ))}
        </div>
      ) : null}
    </details>
  )
}
