## What changed

<!-- What can a buyer, provider or connected agent do more clearly or reliably? Use docs/PRODUCT.md for product framing. -->

## How I verified it
<!-- Include the affected flow and its failure path. Label fixtures, local checks, testnet runs and production observations accurately. Never include credentials or private customer data. -->


## Contract impact
- [ ] No change to `packages/contracts/` or `docs/01-api-contract.md`
- [ ] **Changes the contract** - title starts with `contract:` and the other person has 👍'd

## Checklist
- [ ] The affected marketplace flow has a clear next step for each participant
- [ ] Failure path handled (timeout / empty / malformed / rate-limited)
- [ ] Prices, payment status and spending permissions remain distinct and accurate
- [ ] Measured or estimated claims have an appropriate source and uncertainty label
- [ ] Product and integration docs match the behavior changed here
- [ ] No hardcoded chain-agnostic addresses; no assumed token decimals
- [ ] No secrets
