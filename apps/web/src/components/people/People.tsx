'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api, type Seller } from '@/lib/api'

/**
 * People who can be found and hired.
 *
 * The board could take money for work and wait for somebody to appear, which is
 * one half of hiring a person and not the half anybody reaches for first.
 * Somebody who needs a contract read in Mandarin wants to find the person, not
 * describe the job and hope.
 *
 * Nothing on a listing is verified and nothing pretends to be. The name and the
 * sentence are typed by whoever is listing, so they carry no weight here and are
 * not dressed up as though they did. What carries weight is the count beside
 * them, which comes from work that settled through that address and cannot be
 * edited into something better.
 */

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export function People() {
  const say = useToast()
  const [people, setPeople] = useState<Seller[]>([])
  const [kinds, setKinds] = useState<Record<string, string>>({})
  const [me, setMe] = useState<string | null>(null)
  const [mine, setMine] = useState<Seller | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [blurb, setBlurb] = useState('')
  const [rate, setRate] = useState(500)
  const [takes, setTakes] = useState<string[]>([])

  const load = useCallback(() => {
    api
      .sellers()
      .then((r) => {
        setPeople(r.sellers)
        setKinds(r.kinds)
      })
      .catch(() => {})
    api
      .me()
      .then((m) => {
        const address = m.address.toLowerCase()
        setMe(address)
        return api.seller(address)
      })
      .then((listing) => {
        setMine(listing)
        setName(listing.name)
        setBlurb(listing.blurb)
        setRate(listing.ratePoints)
        setTakes(listing.kinds)
      })
      // Not signed in, or not listed yet. Both are ordinary and neither is an
      // error worth putting on the screen.
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  const save = () => {
    setBusy(true)
    api
      .putSeller({ name, blurb, kinds: takes, ratePoints: rate, available: true })
      .then(() => {
        say('Listed. People can hire you now.')
        setEditing(false)
        load()
      })
      .catch((error: Error) => say(error.message || 'That did not save.'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-[22px] px-[18px] py-[26px]">
      <header>
        <h1 className="m-0 text-[22px] font-bold">People</h1>
        <p className="text-muted mt-[6px] mb-0 max-w-[64ch] text-[13.5px] leading-[1.55] text-pretty">
          For work no agent measurably does. Anybody can list, and nothing on a listing is checked,
          so the name and the sentence are worth what anybody typing them is worth. The count beside
          them is not typed: it comes from work that actually settled here.
        </p>
      </header>

      {me ? (
        <section className="rounded-[18px] border border-[rgb(255_77_0_/_0.35)] bg-[rgb(255_77_0_/_0.04)] px-[18px] py-[15px]">
          <div className="text-[13.5px] font-bold">
            {mine ? 'Your listing' : 'You are not listed'}
          </div>
          {mine && !editing ? (
            <>
              <p className="text-muted mt-[6px] mb-0 text-[12.5px] leading-[1.5]">
                {mine.name}. {mine.blurb}
              </p>
              <p className="text-faint mt-[6px] mb-0 text-[11.5px] font-semibold">
                {mine.record.delivered} delivered · {mine.record.earnedPoints.toLocaleString()}{' '}
                points earned
              </p>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="mt-[10px] h-[32px] rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-[13px] text-[12.5px] font-bold"
              >
                Change it
              </button>
            </>
          ) : editing || !mine ? (
            <div className="mt-[10px] flex flex-col gap-[9px]">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What to call you"
                className="h-[34px] rounded-[10px] border border-[rgb(26_26_25_/_0.14)] bg-white px-[11px] text-[13px]"
              />
              <textarea
                value={blurb}
                onChange={(e) => setBlurb(e.target.value)}
                rows={3}
                placeholder="One sentence on what you do and how somebody would know you did it well."
                className="rounded-[12px] border border-[rgb(26_26_25_/_0.14)] bg-white px-[11px] py-[9px] text-[13px] leading-[1.5]"
              />
              {/* The same fixed list a task is posted under, so there is nothing
                  somebody can offer that nobody is able to ask for. */}
              <div className="flex flex-wrap gap-[6px]">
                {Object.entries(kinds).map(([key, description]) => (
                  <button
                    key={key}
                    type="button"
                    title={description}
                    onClick={() =>
                      setTakes((t) => (t.includes(key) ? t.filter((k) => k !== key) : [...t, key]))
                    }
                    className="h-[28px] rounded-full border px-[11px] text-[12px] font-semibold transition-colors"
                    style={{
                      borderColor: takes.includes(key)
                        ? 'var(--color-ink-app)'
                        : 'rgb(26 26 25 / 0.16)',
                      background: takes.includes(key) ? 'rgb(26 26 25 / 0.06)' : 'white',
                    }}
                  >
                    {key}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-[8px]">
                <span className="text-muted text-[12.5px] font-semibold">Usually asks</span>
                <input
                  value={rate}
                  inputMode="numeric"
                  onChange={(e) => setRate(Math.max(0, Number(e.target.value) || 0))}
                  className="h-[34px] w-[100px] rounded-[10px] border border-[rgb(26_26_25_/_0.14)] bg-white px-[10px] text-[13px] font-semibold tabular-nums"
                />
                <span className="text-muted text-[12.5px] font-semibold">points</span>
                <button
                  type="button"
                  disabled={busy || !name.trim() || !blurb.trim() || !takes.length}
                  onClick={save}
                  className="bg-ink-app hover:bg-orange-app h-[34px] rounded-[10px] border-0 px-[15px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
                >
                  {mine ? 'Save' : 'List me'}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section>
        <h2 className="m-0 text-[15px] font-bold">Available</h2>
        {people.length ? (
          <ul className="mt-[10px] flex list-none flex-col gap-[10px] p-0">
            {people.map((s) => (
              <li
                key={s.address}
                className="rounded-[16px] border border-[rgb(26_26_25_/_0.1)] bg-white px-[16px] py-[13px]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
                  <span className="text-[14px] font-bold">{s.name}</span>
                  <span className="text-muted text-[12.5px] font-semibold tabular-nums">
                    from {s.ratePoints.toLocaleString()} points
                  </span>
                </div>
                <p className="text-muted mt-[5px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
                  {s.blurb}
                </p>
                <div className="text-faint mt-[7px] text-[11.5px] font-semibold">
                  {s.kinds.join(', ')} · {short(s.address)}
                </div>
                {/* Counted, not claimed. Somebody with nothing here is new,
                    which is said rather than left to look like a warning. */}
                <div className="mt-[7px] text-[11.5px] font-semibold">
                  {s.record.delivered ? (
                    <span>
                      {s.record.delivered} delivered · {s.record.earnedPoints.toLocaleString()}{' '}
                      points earned
                      {s.record.disputed ? ` · ${s.record.disputed} disputed` : ''}
                    </span>
                  ) : (
                    <span className="text-faint">Nothing delivered here yet. New, not judged.</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted mt-[10px] mb-0 text-[13px] leading-[1.55]">
            Nobody is listed yet. If you can do something an agent cannot, list yourself above and
            agents will be able to find you.
          </p>
        )}
      </section>
    </div>
  )
}
