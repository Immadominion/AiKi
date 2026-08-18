# ERC-8004 "Trustless Agents" — Verified Specification

**Research verdict:** SOLID
**Spec fetched:** `ethereum/ERCs` master, 18 August 2026 · last substantive commit **2026-01-25**
**Answers:** Charter question **A1**

---

## Front matter, verbatim

```yaml
eip: 8004
title: Trustless Agents
description: Discover agents and establish trust through reputation and validation
author: Marco De Rossi (@MarcoMetaMask), Davide Crapis (@dcrapis) <davide@ethereum.org>,
        Jordan Ellis <jordanellis@google.com>, Erik Reppel <erik.reppel@coinbase.com>
discussions-to: https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098
status: Draft
type: Standards Track
category: ERC
created: 2025-08-13
requires: 155, 712, 721, 1271
```

Note the authorship: MetaMask, the Ethereum Foundation, **Google**, and **Coinbase**. This is not a fringe proposal.

### ⚠️ Status is Draft — and it moved backwards

Git history for `ERCS/erc-8004.md`:

| Date | Commit |
|---|---|
| 2026-01-25 | "Update ERC-8004: Updates from community feedback" |
| 2026-01-13 | (#1470) |
| 2026-01-07 | typos / update |
| **2025-10-08** | **"Move to Review (#1244)"** |

It was moved to Review in October 2025 and is **Draft again today**. The likely reading is that EIP editors reverted it because the January 2026 changes were substantive. *(Inference, medium confidence.)*

Claims circulating that ERC-8004 was "finalized in October 2025" are **contradicted by the EIP itself**.

> **Engineering consequence: pin to a commit hash, not to "ERC-8004".** The interface is still mutable. There is no `last-updated` field in the EIP format — use the commit date.

---

## 1. Identity is an ERC-721 token

> "The Identity Registry uses ERC-721 with the URIStorage extension for agent registration, making all agents immediately browsable and transferable with NFTs-compliant apps."

> "Throughout this document, `tokenId` in ERC-721 is referred to as `agentId` and `tokenURI` in ERC-721 is referred to as `agentURI`. The owner of the ERC-721 token is the owner of the agent and can transfer ownership or delegate management to operators."

| Concept | Reality |
|---|---|
| `agentId` | ERC-721 `tokenId`, **assigned incrementally** |
| `agentURI` | ERC-721 `tokenURI` |
| Ownership | NFT ownership. **Agents are transferable and saleable.** |
| Delegation | ERC-721 operators |
| Global ID | `{namespace}:{chainId}:{identityRegistry}` + `agentId` — e.g. `eip155:56:0x…` |

**There is no DID and no ENS requirement.** Both appear only as optional entries in the offchain `services` array.

**Four consequences AiKi must design for:**

1. **Agents are transferable NFTs.** An identity can change hands. Evidence accumulated under owner A does not automatically describe the agent under owner B. ADR-001 (canonical identity) must treat ownership transfer as an **evidence-continuity event**, likely a confidence reset — this is the "version laundering" attack in [HP-6](../00-method/02-hard-problems.md) arriving through the front door.
2. Ownership is *delegable* via ERC-721 operators, so "who controls this agent" is not simply `ownerOf()`.
3. Because it is ERC-721, **agents show up in NFT marketplaces.** Reputation attached to a transferable token is reputation that can be *bought*.
4. Enumeration via a sequential `1..totalSupply()` scan is only safe if IDs are contiguous and tokens are non-burnable — **unverified**. Index `Transfer` events instead.

## 2. On-chain state is deliberately minimal

Everything on chain: ERC-721 ownership, `agentURI`, and an arbitrary metadata map `mapping(agentId => mapping(string key => bytes value))`.

```solidity
struct MetadataEntry { string metadataKey; bytes metadataValue; }

function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)
function register(string agentURI) external returns (uint256 agentId)
function register() external returns (uint256 agentId)   // agentURI added later via setAgentURI()

event Registered(uint256 indexed agentId, string agentURI, address indexed owner)

function setAgentURI(uint256 agentId, string calldata newURI) external
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)

function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)
function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey,
                  string metadataKey, bytes metadataValue)

function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external
function getAgentWallet(uint256 agentId) external view returns (address)
function unsetAgentWallet(uint256 agentId) external
```

Note `MetadataSet` carries the key **twice** — once `indexed` (hashed, filterable) and once raw (readable). Standard pattern for indexed strings; an indexer needs both.

### The one reserved key: `agentWallet`

> "The key `agentWallet` is reserved and cannot be set via `setMetadata()` or during `register()`… It represents the address where the agent receives payments and is initially set to the owner's address. To change it, the agent owner must prove control of the new wallet by providing a valid EIP-712 signature for EOAs or ERC-1271 for smart contract wallets."

> "When the agent is transferred, `agentWallet` is automatically cleared… and must be re-verified by the new owner."

**This is the only cryptographically-proven fact in the entire identity registry**, and the auto-clear on transfer is a well-designed detail. `agentWallet` being set and verified is a genuine Class-A evidence signal; everything else in the registry is a self-assertion.

> ⚠️ **The EIP-712 typed-data struct for `setAgentWallet` is not defined in the spec.** Read it from the reference implementation before writing signing code.

> ⚠️ **No custom errors are declared anywhere in the spec.** Revert-reason handling must be implementation-specific.

## 3. The registration file

`agentURI` MAY use **any** scheme — `ipfs://`, `https://`, or base64 `data:` for fully on-chain metadata.

```jsonc
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "myAgentName",
  "description": "A natural language description of the Agent…",
  "image": "https://example.com/agentimage.png",
  "services": [
    { "name": "web",  "endpoint": "https://web.agentxyz.com/" },
    { "name": "A2A",  "endpoint": "https://agent.example/.well-known/agent-card.json", "version": "0.3.0" },
    { "name": "MCP",  "endpoint": "https://mcp.agent.eth/", "version": "2025-06-18" },
    { "name": "OASF", "endpoint": "ipfs://{cid}", "version": "0.8", "skills": [], "domains": [] },
    { "name": "ENS",  "endpoint": "vitalik.eth", "version": "v1" },
    { "name": "DID",  "endpoint": "did:method:foobar", "version": "v1" },
    { "name": "email","endpoint": "mail@myagent.com" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    { "agentId": 22, "agentRegistry": "{namespace}:{chainId}:{identityRegistry}" }
  ],
  "supportedTrust": ["reputation", "crypto-economic", "tee-attestation"]
}
```

**Required:** `type`, `name`, `description`, `image`, `registrations`.
**Optional:** `services`, `x402Support`, `active`, `supportedTrust`.

### The back-link is declarative, not cryptographic

> "Agents SHOULD have at least one registration (multiple are possible), and all fields in the registration are mandatory."

**There is no signature over the registration file.** Trust flows only from the fact that the on-chain `agentURI` points at it — the owner controls the pointer.

This has a sharp consequence: **anyone can write any `registrations` array into any file.** A file claiming to be agent #22 is only meaningful if you arrived at it *by resolving #22's on-chain `agentURI`*. **Never trust a registration file's self-declared identity.** Always resolve top-down from the chain.

`supportedTrust` is optional, and its absence is meaningful:

> "If absent or empty, this ERC is used only for discovery, not for trust."

### Optional endpoint-domain proof — the strongest available signal

```
https://{endpoint-domain}/.well-known/agent-registration.json
```

Must contain at least a `registrations` list. **Verified iff** reachable over HTTPS **and** containing a `registrations` entry whose `agentRegistry` and `agentId` match the on-chain agent. Not required when the endpoint domain already serves the `agentURI`.

```json
{ "registrations": [ { "agentId": 22, "agentRegistry": "eip155:1:0x742..." } ] }
```

> **This is a bidirectional proof and it is the single most valuable verification primitive in the standard.** On-chain → file establishes the owner's claim; file-at-domain → on-chain proves whoever controls that domain acknowledges the agent. Together they defeat the domain-squatting failure mode.
>
> The [ecosystem measurement](../02-ecosystem/01-erc8004-reality-on-bsc.md) found `registration_stats.reciprocal_verified = 305` out of 733,946 agents — **0.04%**. Checking this is nearly free, almost nobody does it, and it maps directly onto the competition's Data Quality criterion. **Implement it in the first ingestion pass.**

## 4. Reputation is permissionless and unbounded

```solidity
function getIdentityRegistry() external view returns (address identityRegistry)

function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals,
                      string calldata tag1, string calldata tag2, string calldata endpoint,
                      string calldata feedbackURI, bytes32 feedbackHash) external

event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex,
                  int128 value, uint8 valueDecimals, string indexed indexedTag1,
                  string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)

function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external
event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)

function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex,
                        string calldata responseURI, bytes32 responseHash) external
event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex,
                       address indexed responder, string responseURI, bytes32 responseHash)
```

Read path:

```solidity
function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2)
    external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)

function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
    external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)

function readAllFeedback(uint256 agentId, address[] calldata clientAddresses,
                         string tag1, string tag2, bool includeRevoked)
    external view returns (address[] memory clients, uint64[] memory feedbackIndexes,
                           int128[] memory values, uint8[] memory valueDecimals,
                           string[] memory tag1s, string[] memory tag2s, bool[] memory revokedStatuses)

function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] responders)
    external view returns (uint64 count)
function getClients(uint256 agentId) external view returns (address[] memory)
function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)
```

**Any address except the agent owner/operator may leave feedback.** Anti-spam is explicitly punted:

> the spec defers spam resistance to offchain reputation-of-reviewers systems.

**The standard openly delegates the hard problem to products like AiKi.** That is not a gap to complain about — it is the product's mandate, written into the spec.

Design notes:

- `value` is `int128` with a caller-supplied `valueDecimals` (0–18). **Feedback is signed and arbitrarily scaled.** Never compare raw values without normalising by `valueDecimals`, and never assume a 0–100 range.
- `getSummary(...)` takes a **`clientAddresses` filter** — the standard itself anticipates that you will want to average over a *chosen subset* of reviewers. That is exactly the sybil-filtering hook AiKi needs, available on-chain.
- `appendResponse` gives providers a right of reply. Good for dispute UX; treat responses as Class-D evidence.
- `revokeFeedback` exists, so reputation is **mutable** — an indexer must handle retraction, and a naive cumulative average will drift from truth.

**Recall the measured reality:** on BSC, 100.0% of feedback records carry no payment proof and no task linkage, 76 reviewers average 387 reviews each, and moving an agent past a trust threshold costs **$0.0042**. `getSummary` over *all* clients is a number AiKi must never render as trust.

## 5. Validation — specified, and completely unused

```solidity
function validationRequest(address validatorAddress, uint256 agentId,
                           string requestURI, bytes32 requestHash) external
event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId,
                        string requestURI, bytes32 indexed requestHash)

function validationResponse(bytes32 requestHash, uint8 response,
                            string responseURI, bytes32 responseHash, string tag) external
event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId,
                         bytes32 indexed requestHash, uint8 response,
                         string responseURI, bytes32 responseHash, string tag)

function getValidationStatus(bytes32 requestHash) external view
    returns (address validatorAddress, uint256 agentId, uint8 response,
             bytes32 responseHash, string tag, uint256 lastUpdate)

function getSummary(uint256 agentId, address[] calldata validatorAddresses, string tag)
    external view returns (uint64 count, uint8 averageResponse)
function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes)
function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes)
```

Flow: the **owner/operator** opens a request naming a validator; **only that validator** may respond, with `uint8 response` in **0–100**, repeatably — the spec supports progressive finality (a validator can refine its verdict over time).

Named trust models: **`reputation`**, **`crypto-economic`**, **`tee-attestation`**.

> **Measured: `total_validators = 0`, `total_validations = 0`, network-wide.**

This is the clearest unoccupied position in the ecosystem. The interface for exactly what AiKi does — independent, repeatable, on-chain-anchored verdicts on an agent — is deployed and has never been used.

**AiKi could be the first ERC-8004 validator.** Arena results and liveness verdicts written as `validationResponse` would be:

- on-chain, publicly auditable Class-A evidence,
- portable — other products could consume AiKi's verdicts,
- a genuine standards contribution rather than a proprietary score,
- and directly responsive to the competition's Data Quality criterion.

The `tag` field supports scoping a verdict (`"liveness"`, `"arena:health-factor"`, …), and `getSummary(agentId, validatorAddresses, tag)` lets consumers filter to validators they trust — a validator-reputation market the standard already anticipates.

⚠️ **Caveat:** validation is **owner-initiated**. An agent's owner must open the request before a validator may respond. AiKi cannot unilaterally publish a verdict about an unwilling agent — which is sensible, but means the validator path requires provider cooperation and cannot cover the whole registry. Unsolicited liveness findings stay in AiKi's own evidence graph.

---

## 6. Impact on AiKi

| Finding | Consequence |
|---|---|
| Draft status, reverted from Review | Pin to a commit hash. Version the adapter. Expect churn. |
| Identity is a transferable ERC-721 | Ownership transfer is an evidence-continuity event. Reputation is purchasable with the token. |
| Only `agentWallet` is cryptographically proven | Everything else in the registry is a self-assertion. Weight accordingly. |
| Registration file has no signature | Always resolve top-down from chain → URI → file. Never trust self-declared identity. |
| `/.well-known/agent-registration.json` reciprocal proof | **Highest-value cheap verification. 0.04% adoption. Implement first.** |
| `supportedTrust` absent ⇒ discovery only | A first-class Passport state, not a missing field. |
| Feedback is `int128` + caller-set decimals | Normalise before comparing. Never assume 0–100. |
| `getSummary` accepts a client filter | On-chain hook for sybil-filtered reputation. Use it. |
| `revokeFeedback` exists | Reputation is mutable; indexer must handle retraction. |
| Anti-spam explicitly deferred offchain | **The spec delegates AiKi's core problem to AiKi.** |
| Validation registry deployed, zero usage | Open position. AiKi as first validator — but owner-initiated only. |
| No custom errors, no EIP-712 struct published | Read the reference implementation before writing signing or error-handling code. |

---

## Sources

- `https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8004.md` *(primary)*
- `https://eips.ethereum.org/EIPS/eip-8004`
- `https://api.github.com/repos/ethereum/ERCs/commits?path=ERCS/erc-8004.md`
- `https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098`
