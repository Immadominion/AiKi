# Probe scheduling and freshness repair

## Scope and evidence

Continue the approved production repair in the existing design. The worker is running, but its never-probed-first queue starves previous observations. On 10 September, 7,127 never-probed and 23,891 previously probed registrations were due. All 13 historically LIVE registrations were older than the existing 24-hour recheck threshold. Historical measurements are genuine and must not be deleted or rewritten.

## Decision

Keep the existing production budget of 40 probes every 30 minutes, with concurrency four. Reserve a quarter of each bounded batch for due historically LIVE entries, a quarter for other due rechecks and half for new registrations. Borrow unused capacity from the other lanes. Order deterministically using the complete subject identity. Small batch limits must remain bounded and useful; malformed limits must not generate unbounded work.

This is preferable to increasing the request budget, which does not fix starvation, or global oldest-first ordering, which can starve new registrations. The 24-hour threshold means eligible for recheck, not a guaranteed refresh deadline for the entire registry.

Represent freshness separately from the historical verdict. A successful observation at most 24 hours old is current; older, missing, invalid or future timestamps cannot support a current-answering claim. Preserve the original verdict, timestamp and evidence. Current-ready filtering and counts must use the same freshness rule. Old observations should appear as last known, not as current green availability. Use the existing neutral, stale and freshness styling without redesigning cards or adding a new dashboard.

## Release order and verification

1. Implement bounded fair selection and tests for persistent new backlogs, quota borrowing, small limits and full-subject identity.
2. Add shared freshness metadata and matching backend, UI, filtering and boundary tests. Preserve historical evidence and retry/error states.
3. Review the complete diff and run the application regression suites.
4. Verify fresh first-party observations through the real read-only probe workflow before enabling strict current-ready gating in production. Do not manufacture timestamps or bypass provider authentication. No paid tasks, financial actions or strategy activation belong to this repair.
5. Verify deployed queue behavior, fresh marketplace presentation, unchanged historical evidence and no unexpected increase in probe budget.

No database migration, registry rewrite, new signing permission, financial transaction or new external-provider execution support is part of this change.
