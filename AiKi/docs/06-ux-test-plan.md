# UX test plan

Everything to walk, in the order a real person would hit it. Written to be ticked
off, not read once.

**Setup.** `pnpm --filter @aiki/web dev` → `localhost:3000`. The **MOCK** tab on the
right edge (or `⌘⇧M`) opens the local controls: seed demo, seed fresh, wipe, step
a job by hand, and a JSON box you can paste any state into.

Three states worth testing from:

- **Wipe** — no wallet. What a stranger sees.
- **Fresh** — connected, nothing hired. What a real new user sees.
- **Demo** — two working, one paused, a week of history, one approval waiting.

---

## 0 · First contact

- [ ] `/` loads with no wallet: greeting reads **Welcome to AiKi**, no name
- [ ] Status pill says **No agents yet**, dot is grey and not breathing
- [ ] Top-right avatar is a `+` and goes to `/welcome`
- [ ] Under the field: **New here? Take the walkthrough**
- [ ] Shard cards drift, and each one lands on that agent's passport
- [ ] Hint text rotates every ~4s; `Tab` on an empty field accepts it
- [ ] `⌘/` opens the ask history; `Esc` closes it
- [ ] Bottom-left **Your asks** pill and bottom-right view switch never overlap
- [ ] "how we test" goes to `/how-we-test`

## 1 · Onboarding — `/welcome`

- [ ] Four steps; the progress rail fills as you go
- [ ] **Skip for now** exits to the home you have selected
- [ ] Step 1 explains what connecting does *and does not* grant
- [ ] Pressing **Connect wallet** actually connects (check the MOCK panel)
- [ ] Step 2 **Continue** is disabled until a kind of work is picked
- [ ] Step 3 names the work you picked and the agent with the most evidence
- [ ] Step 3 cap chips change selection
- [ ] Step 4 writes the home-layout preference — verify it in the sidebar after
- [ ] **Back** works from every step and keeps your choices
- [ ] Final button says **Open AiKi** or **Open the market** depending on step 4
- [ ] Landing after finish matches the layout you chose

## 2 · Ask → results

- [ ] Type "protect me from liquidation" → panel shows matching kinds of work
- [ ] Type "mint an nft" → panel says AiKi claims four kinds of work today
- [ ] `Enter` goes to `/explore?q=…`
- [ ] Results header reads the query back and names how it was understood
- [ ] Coverage block shows **shown of matched**, and *why* the rest were excluded
- [ ] A query we do not understand reports **nothing matched** — not a fake count
- [ ] The no-match state offers the four kinds of work, and each is clickable
- [ ] Ask history: a row refills the field / reopens the result

## 3 · Explore — `/explore`

- [ ] Tabs actually filter: **Suggested** (5) · **All** (6) · **Tested most** (6)
- [ ] Tab hint text changes per tab
- [ ] **Tested most** is ordered by check count, descending
- [ ] Evidence bars: Guardian 5 filled, Sentinel 1, and empty bars read as
      missing evidence rather than as a bad score
- [ ] **Save** toggles to **Saved**, and the agent appears in `/saved`
- [ ] Save survives a reload
- [ ] **View** opens the passport
- [ ] **Compare** opens `/compare`
- [ ] **How we test** under the table opens `/how-we-test`

## 4 · Passport — `/agent/[key]`

Walk **guardian** (thick evidence), **sentinel** (thin), **harbor** (degraded + a
vendor-held cap).

- [ ] Header: mark, name, liveness in plain language, price, **Compare**, **Hire**
- [ ] Harbor shows the **slow** banner; Guardian does not
- [ ] **Evidence** tab
  - [ ] Guardian scores **95**, band 95–99 on 174 checks
  - [ ] Sentinel scores **≈50**, band 49–97 on 7 checks — the rounding is the point
  - [ ] Sentinel's unobserved components read **never observed**, not `0`
  - [ ] Component bands are each drawn separately
- [ ] **What it can do** tab: capabilities, permissions, and where each limit is
      held — T0 quiet, anything weaker loud
- [ ] Harbor's vendor-held cap shows the "we have not read the enforcing code"
      callout
- [ ] **Identity** tab: unproven wallet and no reciprocal proof both read as
      caveats, not as failures
- [ ] **Risks** tab: worst first
- [ ] Tabs do not wrap on a phone; the row scrolls

## 5 · Compare — `/compare`

- [ ] Guardian vs Sentinel → **We cannot tell these apart yet**
- [ ] The reason names both scores and both ranges
- [ ] **What would settle it** gives a check count *and* a duration
- [ ] Guardian vs LPilot → separated verdict, no projection block
- [ ] Swapping the second agent from the chips reruns the verdict
- [ ] Cells with no evidence say **never observed**
- [ ] The table scrolls sideways rather than squashing on a phone

## 6 · Hiring — `/agent/[key]/hire`

The screen worth the most attention.

- [ ] Every control carries its own enforcement badge
- [ ] **Guardian**: all four limits read **On-chain**
- [ ] **YieldMax** + "a month" → badge flips to **AiKi only**, headline goes amber,
      and the caveat explains the session module holds lifetime caps only
- [ ] Switching that back to **in total, ever** returns it to On-chain
- [ ] **Sentinel** shows "It cannot spend" instead of the money controls
- [ ] Summary lists exactly what you granted, in your words
- [ ] Headline is the **weakest link**, never an average
- [ ] Expiry chips update the "Stops on …" date
- [ ] Approval mode selection changes the summary line
- [ ] **Sign and hire** creates the agent and lands on its live job

## 7 · Mission control — `/jobs/[id]`

- [ ] The job advances on its own roughly every 1.4s
- [ ] The refusal happens **at the per-action cap you chose** — hire at $40 and
      it refuses $45.60; hire at $150 and it refuses $171
- [ ] The refusal is the loudest row; routine checks are nearly silent
- [ ] Transaction hashes are stable across reloads
- [ ] The approval blocks the top of the page, shows the amount and a deadline,
      and says "if you do nothing, it does nothing"
- [ ] The job stops dead while waiting — leave it a minute and nothing advances
- [ ] **Go ahead** resumes; **No** ends the job and logs a refusal you can see
- [ ] **Pause** stops it; **Resume** restarts under the same limits
- [ ] **Revoke** asks first, and offers pause as the alternative
- [ ] Revoking removes the agent and returns you to `/agents`
- [ ] Spend meter climbs as the job spends
- [ ] The receipt placeholder becomes a real button when the job finishes
- [ ] Reload mid-job: nothing is lost
- [ ] Open a job id that does not exist → honest "not running any more" state

## 8 · Receipt — `/receipts/[id]`

- [ ] Lists **every** action including the one that was refused
- [ ] The refused row has no transaction and says "never signed, never broadcast"
- [ ] Costs split three ways, and the total adds up
- [ ] Mandate hash present, and changes if you hire with different limits
- [ ] Verify URL points at `useaiki.xyz`, not at an internal route
- [ ] A receipt id that does not exist → honest empty state

## 9 · My agents — `/agents`

- [ ] Tabs filter: Working / Paused / All
- [ ] **Paused** with nothing paused says so, rather than showing an empty table
- [ ] Status pill matches reality: Working, Waiting on you, Paused by you
- [ ] Spend meter turns orange past a quarter of the cap
- [ ] **Pause** flips the row and the tab it belongs to, immediately
- [ ] **Open** goes to that agent's live job
- [ ] Banner appears only once something has actually been blocked
- [ ] Empty (fresh) and no-wallet (wipe) states both read correctly

## 10 · Activity — `/activity`

- [ ] Everything / Money moved / Blocked each show a different set
- [ ] With nothing blocked: **Nothing was blocked** — framed as a good week
- [ ] Banner totals match what the agents actually spent
- [ ] **Export** downloads a CSV; open it and check the refused row is in there
- [ ] Quotes inside a description do not break the CSV row
- [ ] Newest first

## 11 · Limits — `/limits`

- [ ] Headline is the weakest link across everything authorised
- [ ] Each agent shows **the caps you chose**, marked *Yours*, separately from the
      passport's own enforcement claims
- [ ] **Pause everything** pauses every agent and the rows say so
- [ ] Revoke asks first and offers pause
- [ ] Banner counts the limits not held by the chain
- [ ] Empty and no-wallet states

## 12 · Saved — `/saved`

- [ ] Saving from Explore and from a market card both land here
- [ ] Empty state explains that saving grants nothing
- [ ] Unsaving removes it

## 13 · How we test — `/how-we-test`

- [ ] Sweep bars are proportional and the percentages add to 100
- [ ] The "not one agent was fully live" callout is present
- [ ] Rules D0–D10 read as plain language, not as jargon
- [ ] The naive-percentage comparison shows 100% → 51 and 98% → 95
- [ ] The limits-of-the-method section is present and honest

## 14 · Settings — `/settings`

- [ ] Sidebar Wallet / Notifications / Evidence API each deep-link to a section
- [ ] **Connect** / **Disconnect** actually change state, and the shell follows
- [ ] Disconnect copy is explicit that it is *not* revoking
- [ ] Home layout toggle here matches the sidebar control
- [ ] **Clear** wipes browser storage and the app returns to defaults

## 15 · Shell

- [ ] `⌘K` opens the palette from anywhere
- [ ] Typing "liquid" matches two kinds of work
- [ ] Typing nonsense still offers **Ask AiKi for "…"**
- [ ] Arrow keys move, `Enter` runs, `Esc` closes, backdrop click closes
- [ ] Sidebar collapse persists across reloads
- [ ] Collapsed: badge counts become dots, layout card becomes one toggle,
      the AiKi mark stays visible
- [ ] Notifications: ordered by what it costs to miss, **Mark all read** works,
      each row lands on the right page
- [ ] Account menu: copy address works, and fails honestly if the browser refuses
- [ ] Status panel: pause works from inside it

## 16 · States

- [ ] First paint shows a skeleton, never a flash of the wrong answer
- [ ] Throttle the network and confirm the skeleton is shaped like the content
- [ ] Force an error (edit the JSON in the MOCK panel to something invalid) →
      the error boundary leads with "nothing was changed and nothing was spent"
- [ ] `/agent/does-not-exist` → not-found explains transferred identities
- [ ] Freshness pill disappears when no wallet is connected

## 17 · Responsive

Check at **390** (phone), **768** (tablet), **1180**, **1440**.

- [ ] No horizontal scroll on any route at any width
- [ ] ≤767: sidebar is a drawer, hamburger appears, drawer closes on navigate
- [ ] ≤767: ask page drops shards, nav links, and the TAB affordance
- [ ] Detail headers stack rather than squeezing the title to one word per line
- [ ] Tables scroll inside their own container, not the page
- [ ] Pause / Revoke / approval buttons go full width on a phone
- [ ] Dialogs and dropdowns fit the screen

## 18 · Keyboard and reduced motion

- [ ] `Tab` from the top reaches **Skip to content** first
- [ ] Every interactive element shows an orange focus ring
- [ ] Focus order matches reading order
- [ ] Nothing is reachable only by hover
- [ ] With `prefers-reduced-motion: reduce`, drift and breathing stop and
      everything still reads correctly

## 19 · Copy pass

Read every screen and flag anything that:

- [ ] Names a number without saying what it is measured from
- [ ] Uses an enum or an internal term (`T0`, `IMPOSTOR_STATIC`, `NO_DATA`)
- [ ] Says "no data" where it means "we have not measured this yet"
- [ ] Promises something the mandate cannot actually enforce
- [ ] Describes an action as safe without saying who holds the limit
- [ ] Reads as marketing rather than as a statement of fact

---

## Known gaps

Things deliberately not built, so they are not bugs:

- Wallet connection is simulated. No signature is requested and no chain is read.
- Search matches four kinds of work by keyword. It is not semantic.
- Filter chips in the top bar (date range, protocol) are decorative.
- The Evidence API is described but not served.
- Freshness always reports LIVE — nothing can go stale until there is a source.
