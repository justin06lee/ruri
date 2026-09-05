# Codex harness integration

Verified September 5, 2026. This work uses the installed Codex app-server through Yagami, preserving the user's CLI configuration and available model catalog. It adds no agent skills or instruction packs.

## Research and implementation

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server) defines native questions, MCP elicitation, live plans, reasoning deltas, request resolution and exact thread forks. Yagami owns those wire contracts; Ruri consumes provider-neutral events and typed requests.

The [Astra guidance](https://developers.openai.com/api/docs/guides/latest-model) emphasizes task continuity, calibrated verification, and deliberate delegation. Those goals support preserving native conversation history and observable tool progress. They do not justify replacing the user's model, forcing maximum effort, or enabling extra agents globally. Model names and supported efforts continue to come from each installed harness.

- Native questions and MCP/ACP forms reach the question card. Option values, booleans, integers, optional fields, defaults and bounds survive the round-trip. Secret answers use password inputs and are absent from transcript events.
- Provider plans update one durable transcript event per turn. Provider item IDs cannot overwrite Ruri's event ID. Codex's completed proposed-plan document is also retained.
- Visible prompts explicitly identify the model payload sent underneath them, including split prompts, so native turn IDs attach to the correct exchange.
- Codex forks and rewinds retain real thread context. Rewinds independently restore Ruri's file checkpoint when available. Unsupported providers and retired conversations use the existing compaction brief fallback.
- Reasoning summaries update live progress as they stream. Yagami fills missing completed-summary text without counting the deltas twice.
- Concurrent cold sends are rejected. Host input and approval requests are cancelled when the server resolves them or the turn stops. A failed resume reports an error instead of silently starting an empty conversation. Ruri retires a failed connection before retrying with the saved session ID.

## Verification

Yagami: 177 tests, typecheck and package build pass. Six new regression tests cover reasoning deltas, failed resume, cold-send concurrency, interruption, authoritative plan items and server-resolved requests.

Ruri: typecheck, production macOS app build, provider event integration, command parsing and file-checkpoint checks pass. A real Codex turn edited a temporary repository and rewound its files through Ruri. A separate real native fork retained a codeword from the exact source turn in a distinct thread. Browser checks cover masked secret input, integer validation, defaults, live plans and model-reported effort choices.

The packaged macOS app also boots with an isolated profile and advances native question cards correctly. The provider-event script retains regression coverage for required/optional answers, integer bounds, invalid numeric values, exact boolean and option values, single-answer cardinality and string lengths. The macOS build is unsigned; distribution signing remains separate.

During packaged-app automation, Electron logged a `sandboxed_renderer.bundle.js` startup error (`binding.startupData` was null). The question navigation and model effort controls remained functional. Its cause is unverified; this was not a clean-console check.

## Dependency and release

Ruri currently uses `file:../yagami`. `make` builds that sibling before installing Ruri dependencies; the packaged app bundles Yagami and requires no sibling at runtime. Yagami 0.8.1 is prepared but not published; the registry still serves 0.6.1. After publishing 0.8.1, switch Ruri back to the registry dependency and regenerate `bun.lock`.

The checks validate integration and reliability, not a measured increase in model intelligence or a universal performance optimum. No global model, reasoning, permission or delegation defaults were changed.
