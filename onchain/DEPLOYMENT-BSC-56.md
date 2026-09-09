# BSC mainnet deployment

Deployed on 9 September 2026 from `0x3A637bc6eB7c70479954C1F2d18Cc959e90Fb9b4`.
Chain: 56. Gas paid: **0.0002933743 BNB**. Eight contract creations, each with zero native value.

The suite is **unaudited**. Source verification and passing tests are not an independent security audit.

The production manifest is [bsc-mainnet.json](../apps/api/src/config/deployments/bsc-mainnet.json). It is included in the API and worker image. Mainnet and testnet addresses must never be substituted for one another, even where an address string exists on both chains.

| Contract | Address | Creation transaction |
| --- | --- | --- |
| ExpiryEnforcer | `0x15d7a002e420f66c08ff0f0446f47668c6099121` | [Receipt](https://bscscan.com/tx/0xec576e4caa1bfd4c3c479675f5dac1c3c45b5981f4a461fc0bca4468f04e503a) |
| AllowedTargetsEnforcer | `0x664a7b4f0dcace0c56e21116908d3825dd845f76` | [Receipt](https://bscscan.com/tx/0x2e26d975539745da84286772fa64aaf61d520589e78ebe8412e2d773563b569d) |
| AllowedSelectorsEnforcer | `0x933fc376cce6ae05721b685c432e3c9354ed3775` | [Receipt](https://bscscan.com/tx/0xe8d69d041d88559603bbbe33b0a3e2d023ec6948e32a2e24bddf8faf5037a0d3) |
| AssetScopeEnforcer | `0x0bf91dc7e4125a04ec50bcee4b7e2ae513749fee` | [Receipt](https://bscscan.com/tx/0x08171205fc8c8b1f03f3ad675831169d9a236d174a76f368a041a6d62d43f3d0) |
| AiKiDelegationManager | `0x625cfda19d2f4424e546b610b4cef1f5441f84c9` | [Receipt](https://bscscan.com/tx/0x8fea612832eeb3cc481a852f66deee75cb8e8f2035e6998426b84ee7b63332d1) |
| PerActionCapEnforcer | `0xaf0b9352cbb860c3577a46bbe98e8057a835e959` | [Receipt](https://bscscan.com/tx/0x4b142990648f0dd8a7cdce7524af3b88ba28aefa3727e42b737265f9f7afe8b4) |
| SessionTotalCapEnforcer | `0xdb857f97d05e7b3779e8dee81f9da4fd2d9e76c1` | [Receipt](https://bscscan.com/tx/0x56a892b7cbbaa3af01c05158807279ae7cc8c93a534032d5053b236ac05a89f5) |
| AiKiEnforcerRegistry | `0xfe2a585fd81bbf222a6c9130ea2aae250cb38614` | [Receipt](https://bscscan.com/tx/0x4b63f09024ce7c285577ff6fde2d8e51781d5479fd04179172630390865c9672) |

## Verification performed

- Every creation receipt succeeded. The exact transaction hash, contract address and canonical block hash were checked. All eight blocks were below BSC's finalized height.
- Every deployed runtime matched the locally compiled artifact byte for byte, including substituted constructor immutables. The manager's cached chain ID and EIP-712 domain were recomputed for chain 56 and its actual address.
- The normal API startup verifier passed against mainnet: eight code hashes, six registry mappings, expiry binding and each manager binding.
- Sourcify returned `match` for all eight contracts. Inspect the [manager's verified source](https://sourcify.dev/server/v2/contract/56/0x625cfda19d2f4424e546b610b4cef1f5441f84c9?fields=all) and [registry's verified source](https://sourcify.dev/server/v2/contract/56/0xfe2a585fd81bbf222a6c9130ea2aae250cb38614?fields=all).

Compiler settings: Solidity 0.8.28, Shanghai EVM, optimizer 1,000 runs, via IR, no CBOR metadata. The pinned settings are in [foundry.toml](foundry.toml).

To repeat source verification, run from `onchain`, substituting one contract's address and source name:

```sh
forge verify-contract --verifier sourcify --chain 56 \
  0x625cfda19d2f4424e546b610b4cef1f5441f84c9 \
  src/core/AiKiDelegationManager.sol:AiKiDelegationManager --watch
```

## Scope

This deployment creates enforcement infrastructure. It does not fund user mandate accounts, grant token allowances, create a Venus lending position or prove that a trading strategy completed. Each user account has its own owner and must be created separately. The executor and account-funding keys are separate from the deployment key.
