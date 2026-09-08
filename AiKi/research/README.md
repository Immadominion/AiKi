# Research index

AiKi is a marketplace for humans and AI agents to get work done together. The current [product definition](../docs/PRODUCT.md) sets its scope: discover and hire, agree on the work, deliver it, review it and pay, including handoffs between humans and agents. Fast and Manual are two ways to use that marketplace.

This folder contains the research behind parts of that product. Most findings were recorded on 18-20 August 2026. They retain their observation dates, sources, uncertainties and technical examples. They are not a current deployment inventory or evidence that a proposed capability has shipped.

References to the founding context or original design brief mean their archived versions: [18 August context](../../docs/archive/2026-08-18-initial-agent-context.md) and [19 August design brief](../../docs/archive/2026-08-19-design-system-brief.md). The original filenames now hold current product guidance.

## Start here

| Document | How to use it |
| --- | --- |
| [Research charter](00-method/00-research-charter.md) | Current research method and questions, organised around the marketplace workflow |
| [Status ledger](00-method/03-status.md) | Dated research verdicts and known follow-ups, not current production readiness |
| [Decision register](00-method/01-decision-register.md) | August decision history, with the September product-scope clarification recorded separately |
| [Seven hard problems](00-method/02-hard-problems.md) | Original analysis of measurement, authorization and payment risks; not a complete list of marketplace requirements |
| [System architecture](03-architecture/02-system-architecture.md) | August technical proposal, its later corrections, and how those subsystems support the current product |
| [Feasibility and sequence](04-feasibility/01-feasibility-and-sequence.md) | Historical estimates and build sequence, with the evidence-first priority superseded |

## Protocol studies

These studies answer specific integration questions. A registry identity, probe response or supported protocol does not by itself establish that a provider can accept and complete a job.

| Study | Subject |
| --- | --- |
| [ERC-8004](01-protocols/01-erc8004-trustless-agents.md) | Registry identity, reputation inputs and optional validation |
| [BSC infrastructure](01-protocols/02-bsc-infrastructure.md) | Measured RPC, indexing, replay and execution constraints |
| [MCP revision study](01-protocols/03-mcp-2026-07-28.md) | The particular protocol revision researched, not a claim about the version used by every AiKi client |
| [Adjacent standards](01-protocols/04-adjacent-standards.md) | A2A, AP2, receipts and other integration options |
| [ERC-8183](01-protocols/05-erc8183-commerce.md) | One escrowed-commerce adapter and its deployed ABI differences |
| [x402](01-protocols/06-x402-payments.md) | Paid HTTP and the settlement constraints researched on BSC |
| [Mandate enforcement](01-protocols/07-mandate-enforcement.md) | Initial authorization study; read with the execution-path follow-up |
| [Execution path](01-protocols/08-execution-path.md) | 19 August follow-up to O-2/O-3 and the lifetime-cap recommendation |

Protocol-specific recommendations such as a settlement token, receipt format or authorization mechanism apply to the path studied. They do not make that path mandatory for all human or agent work. Revalidate mutable interfaces, providers and security properties before implementation or a public guarantee.

## Ecosystem and measurement studies

| Study | Subject |
| --- | --- |
| [ERC-8004 on BSC](02-ecosystem/01-erc8004-reality-on-bsc.md) | Dated registry sample, cited studies and supply risks |
| [Build the Era](02-ecosystem/02-build-the-era-competition.md) | Competition requirements and the strategic interpretation recorded in August |
| [BNB Agent Studio](02-ecosystem/03-bnb-agent-studio.md) | Runtime and supply-integration research; registry questions have later answers in the status ledger |
| [Competitive teardown](02-ecosystem/04-competitive-teardown.md) | A comparison of scoring, verification and authority features, not a complete marketplace comparison |
| [20 August probe sweep](02-ecosystem/05-probe-sweep-2026-08-20.md) | Sample results, a missing raw evidence artifact and defects found in the measuring instrument |
| [Measurement science](03-architecture/01-measurement-science.md) | Methods and limits for any scores or benchmarks AiKi chooses to offer |

## Scope and interpretation

Probing, identity, evidence and budgets support informed choices and control. A working marketplace also needs available providers, clear briefs, handoffs, delivery, buyer review, payment and recovery when work fails. The research's earlier proposal to make Arena, Proof Score or the validator role AiKi's identity does not govern current product priorities.

The four BNB categories are requirements for that competition. They do not restrict AiKi's participant model to DeFi agents. Human participation must be designed as work in the marketplace, not only as an approval step for a machine.

Keep dated findings intact when research changes. Add a correction or a linked follow-up, state which recommendation it supersedes, and distinguish a tested implementation from a feasible design. Current scope belongs in [PRODUCT.md](../docs/PRODUCT.md); this index does not certify any untested flow.

Raw source records live in [_raw](./_raw/README.md), including the [design studies](./_raw/design/README.md). Their recommendations are research inputs, not current product commitments.
