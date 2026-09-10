# Pancake V3 arithmetic provenance

Source repository: https://github.com/pancakeswap/pancake-v3-contracts

Pinned commit: `986847948755cba528324d41be19480731c36c2a`.

Original files (all carry `GPL-2.0-or-later`):

- `projects/v3-core/contracts/libraries/FullMath.sol`
- `projects/v3-core/contracts/libraries/TickMath.sol`
- `projects/v3-periphery/contracts/libraries/LiquidityAmounts.sol`
- `projects/v3-periphery/contracts/libraries/OracleLibrary.sol`

The original FullMath credit to Remco Bloemen and its linked MIT-licensed derivation are preserved. These files derive from the Uniswap/Pancake V3 implementations. The resulting strategy/math files retain GPL-2.0-or-later SPDX identifiers; they are not relabeled as MIT.

## Port boundary

PancakeMath combines the original full-precision multiply/divide functions, tick-to-sqrt ratio, liquidity/amount conversions and oracle tick quote. Names/imports and Q96 constants are consolidated. Unused inverse tick and other oracle helpers are omitted. The Solidity 0.8 port changes the signed-to-unsigned cast through int256 and expresses two's complement as `~denominator + 1`. The modular Newton inverse and full-width product arithmetic run unchecked, retaining the original pre-0.8 arithmetic semantics and explicit overflow/zero-denominator guards.

PancakeOracle retains the canonical two-point cumulative arithmetic, negative-mean floor and harmonic-liquidity calculation. Only cumulative counter differences and the uint32 timestamp age intentionally wrap. Added validation checks array sizes, retained initialized history, valid means/ratios, nonzero liquidity, unlocked pool, and spot/TWAP deviation. It does not substitute spot when the oracle cannot be read.

LPOracleMath.t.sol includes canonical tick boundaries, 512-bit product vectors, exact rational liquidity vectors, counter-wrap/negative-rounding regressions, and fuzz checks for monotonicity, bounded-integer parity and inventory conservation. These tests are not a substitute for independent review or real-contract fork integration.

No floating-point, Taylor-series or linear price approximation is used.
