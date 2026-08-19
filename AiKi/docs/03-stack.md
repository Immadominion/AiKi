# Stack — pinned versions

**Verified 19 August 2026** against `registry.npmjs.org` directly. Nothing here is from memory.

> **Rule: pin exact versions.** Two people, three weeks, no time to debug a transitive minor bump.

---

## ⚠️ The three that would have gone wrong

**1. TypeScript — pin `6.0.3`, NOT `7.0.2`.**
`typescript@latest` is now **7.0.2**, the Go-native rewrite (GA 8 Jul 2026, ~10× faster). But it ships **no stable programmatic API until 7.1**, so `typescript-eslint` (8.67.0) cannot consume it — and neither can Volar, ts-loader, or most editor integrations. Adopting "latest" here silently breaks the lint pipeline on day one. Microsoft explicitly maintains 6.x for exactly this reason.
*Write the tsconfig TS7-clean anyway (no `baseUrl`, no `target: es5`, no `moduleResolution: node`) so the eventual bump is one line.*

**2. `framer-motion` is now `motion`.**
Renamed under `motiondivision/motion` after the Framer split. Both publish at 13.1.0 and `framer-motion` is a maintained alias — but new code imports from `motion/react`. **Don't install both**, you'll double-bundle.

**3. `tailwind-merge` must be v3.**
v3 is the Tailwind-v4-aware major. On v2 your class-conflict resolution is wrong against v4's utility set — subtly, not loudly.

Also worth knowing: the shadcn CLI package is **`shadcn`**, not `shadcn-ui` (dead name). And `lucide-react` has graduated from `0.x` to **1.33.0**, so some icon names moved at the 1.0 boundary — old snippets may not resolve.

---

## Frontend — `apps/web`

| Package | Version | Note |
|---|---|---|
| `next` | **16.3.1** | Next 16 shipped Oct 2025 — mature, not bleeding edge. Turbopack is default and stable. App Router only. |
| `react` / `react-dom` | **19.2.8** | Must match exactly |
| `typescript` | **6.0.3** | See above |
| `tailwindcss` | **4.3.3** | CSS-first config — no `tailwind.config.ts`, theme lives in `@theme` in `globals.css` |
| `@tailwindcss/postcss` | **4.3.3** | Keep identical to `tailwindcss`. Delete `autoprefixer` and `postcss-import` — v4 does both |
| `motion` | **13.1.0** | `import { motion } from 'motion/react'` |
| `lucide-react` | **1.33.0** | |
| `clsx` | 2.1.1 | |
| `tailwind-merge` | **3.6.0** | v3 required |
| `class-variance-authority` | 0.7.1 | |
| `@radix-ui/react-slot` | 1.3.3 | |
| `zod` | **4.4.3** | v4 is a rewrite — different error/issue shape from v3 |
| `@tanstack/react-query` | 5.101.4 | |
| `date-fns` | 4.4.0 | |
| `shadcn` (CLI) | **4.18.0** | `pnpm dlx shadcn@4.18.0 init` |

**Not now:** Cache Components / `use cache` / PPR. New programming model, opt-in — skip it on this deadline.

**React 19 caveat that will bite:** every component is a Server Component unless marked `'use client'`. All wallet code — viem, wagmi, anything touching `window.ethereum` — must live behind a client boundary. Put a `<Providers>` client component high in `app/layout.tsx` and keep marketing/listing pages as Server Components.

**Tailwind v4 gotchas when copying v3 snippets:** `shadow-sm`→`shadow-xs`, `ring`→`ring-3`, `outline-none`→`outline-hidden`, `bg-opacity-*`→`bg-black/50`, `!` goes at the *end* (`flex!`), arbitrary vars are `bg-(--brand)` not `bg-[--brand]`.

## Backend — `apps/api`

| Package | Version | Note |
|---|---|---|
| `hono` | **4.13.3** | No v5 exists. Good SSE support, light. |
| `viem` | **2.55.19** | v3 is prerelease only — stay on 2.x. Pin exactly; minors move fast |
| `drizzle-orm` | **0.45.2** | 1.0 is rc only. The 0.31.x kit / 0.45.x orm skew is normal |
| `drizzle-kit` | 0.31.10 | |
| `pg` | **8.23.0** | Preferred over `postgres` (porsager) here |
| `pino` | 10.3.1 | |
| `pg-boss` | 12.27.0 | Postgres-native queue — no Redis needed |
| `tsx` | 4.23.12 | |
| `undici` | 8.10.0 | |
| `@types/node` | *see note* | `latest` (26.2.0) tracks Node **26**, not our LTS. Use the Node 24 line |

**Runtime: Node 24 LTS.** `.nvmrc` pins `24`; verified local is v24.5.0.

## Tooling

| Package | Version | Note |
|---|---|---|
| `pnpm` | **11.22.0** | 12 is rc — don't |
| `turbo` | **2.10.11** | Still the default orchestrator |
| `@biomejs/biome` | **2.5.9** | **Chosen over ESLint + Prettier** — one tool, one config, dramatically faster, and sidesteps the ESLint 10 flat-config migration entirely |
| `vitest` | **4.1.11** | v5 is rc |
| `@vitest/coverage-v8` | 4.1.11 | Must match `vitest` **exactly**, not just the major |
| `@playwright/test` | 1.62.1 | |
| `msw` | 2.15.0 | If we need in-browser mocking beyond the mock server |

*ESLint is at 10.8.1 and `typescript-eslint` at 8.67.0 if we ever switch back — but Biome avoids the TS7 coupling problem entirely.*

## Onchain — `onchain/`

| Tool | Version | Note |
|---|---|---|
| Foundry | **1.7.1** | Verified locally. `anvil` needs `--evm-version prague` to replay BSC blocks (EIP-7702 txs) |
| `solc` | **0.8.36** | Released 2026-07-09 |
| `@openzeppelin/contracts` | 5.6.1 | Keep `-upgradeable` at the identical version |
| `@rhinestone/modulekit` | 0.5.9 | For building the custom spend policy |
| `erc7579/smartsessions` | v1.0.0 | ⚠️ Canonical repo is `github.com/erc7579/smartsessions`, **not** `rhinestonewtf/` |
| `@rhinestone/sdk` | 2.2.2 | |
| `permissionless` | 0.4.0 | Pimlico ERC-4337 client. Requires `viem ^2.44.4` |

⚠️ **Pasteur hardfork lands 25 Aug 2026** — pin client v1.7.7 and re-test the fork boundary after.

---

## Workspace

```
pnpm@11.22.0 · Node 24 · turbo 2.10.11 · Biome 2.5.9

AiKi/
├─ apps/web          Next 16 + React 19 + Tailwind 4        (Joel)
├─ apps/api          Hono + viem + Drizzle + Postgres       (protocol eng)
├─ packages/contracts  types + fixtures + mock server       (shared, contract PRs only)
├─ packages/sdk      public client                          (later)
└─ onchain           Foundry                                (protocol eng)
```

```bash
pnpm install
pnpm mock          # fixture-backed API on :4000
pnpm dev           # everything
pnpm typecheck
pnpm lint          # biome
```

## Deployment

- **Vercel** for `apps/web`. CLI 59.1.4 — use `pnpm dlx vercel@59.1.4` in CI rather than a repo dependency.
- **Railway** for `apps/api`. Needs long-lived connections for SSE — verify the platform doesn't buffer `text/event-stream` before relying on Mission Control's live feed.

---

*Re-verify before any major upgrade. This snapshot is dated 19 Aug 2026; raw research is in `research/_raw/stack/`.*
