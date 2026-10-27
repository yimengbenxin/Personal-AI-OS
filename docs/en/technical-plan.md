# Yimi technical plan

This document explains how Yimi is put together as a whole: which parts are the kernel and which are the platform, how capabilities plug in, which gate each action must pass, and how results are reported truthfully. For the end-to-end flows see [End-to-end flows](flows.md); for mechanisms and measured numbers see the [Technical report](tech-report.md).

## 0 Why a system like this

The future we want is one where everyone has an assistant of their own. She knows you, remembers what you have said, can use every app on your phone, every device in your home and every file on your computer for you, and lives with you from morning to night. Once everyone has such an assistant, many things no longer need to go through a platform: your assistant talks directly with the other person's assistant, and the two of you only nod at the end.

To get there, the assistant first has to be a complete, independent system that belongs to the user. So Yimi rests on three premises:

1. **One system per person, installed on the user's own cloud host.** The whole system runs as containers on a Linux host that meets the deployment requirements. The deployer only configures the model API and provides the database, secrets, TLS and the external services needed.
2. **Models are configuration.** Each role picks its own provider and model; switching models does not wipe memory.
3. **She learns, builds and uses tools on her own.** When a capability is missing, she first looks for an existing one; if none fits, she builds it, and uses it once it has been tested.

## 1 Design principles

| Principle | Meaning | Where it lives |
|---|---|---|
| The kernel is the kernel | Built on the upstream kernel; removing the residual patch is in progress | The three attachments for packages and memory (section 2); a temporary patch and some legacy attachments remain |
| One authority per fact | Each fact is decided in exactly one place; everything else only reads it or keeps a snapshot | Platform services (section 3) |
| One capability format | Migrated capabilities and the ones Yimi builds herself use the same capability package | Agent Plugins v1 + extension block (section 4) |
| Fixed classifications | A new capability takes its slot; no code is added for it | 9 effect classes, 6 kinds of facts (sections 5, 6) |
| The system states the facts | Status and numbers come from receipts; the model supplies only content and tone | Fact sentences + deterministic check (section 6) |
| Safety through isolation, rollback and first-time confirmation, not refusal | Reads only check scope; external effects are confirmed the first time; every payment is confirmed | Gates and rollback (sections 5, 10, 12) |
| Runs unchanged in the cloud | No mechanism specific to one personal computer on the product path | Container deployment (section 11) |

What follows is based on the public 0.1.5 code. End-to-end capabilities marked "in progress" have not finished going live: code that is wired up is not the same as accepted in production.

## 2 Overall structure

![Yimi's overall structure](../images/arch-01-overview.svg)

*Figure 1 | Yimi's overall structure.*

The system has three layers, plus devices and external services:

- **Platform services** (TypeScript, running in the `gateway` container): the single authority for all product rules and facts.
- **Kernel** (the `hermes` container): upstream Hermes Agent plus three attachments.
- **Capability packages**: the uniform format for migrated capabilities, loaded by the kernel on demand, with decisions and bookkeeping done by the platform's capability gateway.

### 2.1 The kernel and its three attachments

Hermes is pinned to upstream v0.22.5, commit `bf0203a` (`integrations/hermes/personal_aios/producer.lock.json`). It still carries a temporary residual patch. Capability packages and memory connect to the platform mainly through these three attachments:

| Attachment | What it does | Location |
|---|---|---|
| Thin plugin `yimi-gateway` | Registers three tool hooks, `pre_tool_call`, `transform_tool_result` and `post_tool_call`, plus nine lifecycle hooks; hands decisions to the platform and turns results into receipts; 133 lines | `integrations/hermes/yimi_gateway/` |
| Memory provider `personal_aios` | An upstream `MemoryProvider`; brings the platform-generated core profile into context every turn; native memory writes are off | `integrations/hermes/personal_aios/__init__.py` |
| Package loading | At deploy time, validates each package's `plugin.json` and, from configuration and switches, generates Hermes's MCP server configuration and skill directories | `capability/packages/load.py`, `deploy/cloud/hermes-init.py` |

During the transition there is also a residual patch marked temporary (`TEMPORARY`), `native-context.patch`. It still contains product logic such as run scopes and the main-agent division of labour; the goal is to remove it entirely (in progress). In addition, `personal_aios` still keeps some tool and middleware registrations.

### 2.2 The main agent only talks; subagents do the work

The main agent converses, judges, reads the memory the conversation needs and states goals. Anything that requires action, even a single tool, goes to a native asynchronous subagent.

This division is implemented by the residual patch, not the thin plugin: in the patch, `CONVERSATION_TOOLS` and `restrict_agent` leave a root agent configured with a delegation toolset only a whitelist of conversation tools, and execution tools are invisible to it. The whole delegation tree of one run shares one tool-call budget (120 in the production configuration); at most 3 subagents run at once, and spawning goes at most 2 levels deep.

## 3 Platform services: the single authority

| Authority | What it owns | Main location (`personal-aios-integration/src/`) |
|---|---|---|
| Identity and admission | Device pairing; voiceprint decisions; the run scope of every turn: the user `owner`, identity unconfirmed `owner_uncertain`, guest `guest`, plus build `build` and care `care` | `admission.ts`, `owner-authority.ts`, `voiceprint/` |
| Consent and payment | First-send and per-action confirmation; payment intent, authorization, checkout verification | `effect-consent.ts`, `capability/consent/`, `payment/` |
| Timeline and memory | L2–L5 memory; a sequenced, page-synced timeline | `memory/`, `timeline.ts`, `archive.ts` |
| Delivery | Replies sent in chunks to the target device; per-device ACKs | `output.ts`, `routing.ts` |
| Voice | Qwen realtime voice sessions and read-aloud | `tts.ts`, `voice/`, gateway side `phase0/gateway/` |
| Activity cards | Cards for background tasks, with status taken straight from receipts | `activity.ts` |
| **Capability gateway** | Call decisions, receipt ledger, fact sentences, deterministic check | `capability/gateway.ts`, `ledger.ts`, `renderer.ts`, `checker.ts` |
| Package registry | Registration checks, publishing, monitoring and per-package rollback for packages Yimi builds | `capability/registry/` |

The ledger and receipts track only two things: what a tool returned, and what has already been said to the user. Every other fact has its own owner: task status belongs to the executor, consent to `effect-consent`, payment authorization to the payment flow, memory to platform memory. The ledger keeps no second copy.

### 3.1 Capability gateway

The gateway exposes three loopback endpoints, matching the thin plugin's three hooks:

- **decide**: decides a call. It binds the user, run and scope from the admission record; injects trusted fields such as session, run, call ID and idempotency key, overriding same-named parameters from the model; reads `owner_requested`, which the adapter filters out before execution; resolves the effect class from the manifest; blocks repeat calls that already succeeded and may not be retried, and blocks retries of unknown outcomes that have not been checked; lets read-only and workspace calls through, and hands the rest to the consent, payment or release authority. There are only four outcomes: allow, rewrite parameters, block, ask for confirmation.
- **receipt**: validates the receipt at the trust boundary, enforces the five invariants, records it idempotently keyed by (task ID, call ID), and renders to the model only the facts not yet delivered.
- **observe**: records only latency and errors; it never changes a receipt already recorded.

When the gateway is unreachable, the thin plugin never assumes success: before execution, capability-package tools are always blocked ("not executed this time"); after execution, the model is told "result not yet verified".

## 4 Capability packages

### 4.1 What a package looks like

```text
mijia/
├── plugin.json                 ← standard manifest + extensions."ai.yimi.capability"
├── mcp.json                    ← MCP entry point (stdio or HTTP)
├── skills/mijia/SKILL.md       ← when and how to use it
├── server/                     ← the package's own code
├── fake/                       ← fake implementation: same tool names and receipts as the real one
└── tests/contract.yaml         ← contract tests: input → expected receipt
```

### 4.2 Manifest extension fields

The extension block `extensions["ai.yimi.capability"]` is validated by `capability/contracts/manifest.v1.schema.json`. Required fields:

| Field | Content |
|---|---|
| `schema`, `receipt_schema` | Extension version and receipt version (integers) |
| `compat` | Compatible Hermes version range and gateway interface version |
| `maintainer` | `lead` (maintained by the platform) or `yimi` (built by Yimi) |
| `runtime` | MCP server name; `lazy` (lazy start); `idle_timeout_seconds` (idle reclaim); `host`: `shared` or `dedicated` |
| `secrets` | Secret names only; values are injected by the platform |
| `network.egress` | Egress allowlist (declared; enforced by the container network policy) |
| `scopes` | Which run scopes can see the package: `owner`, `owner_uncertain`, `guest`, `build`, `care` |
| `tools` | Each tool declares exactly one of `effect` or `effect_by_arg`; optional `target`, `task_type`, `retry`, `check_with`, `context_inject`, `long_running` |
| `staging.fake` | Start command for the fake implementation |
| `tests.contract` | Contract test file |
| `provenance` | Source commit, build record, list of adapter modules |

A package whose `maintainer` is `yimi` may not declare `spend` or `self_change`, including in any branch of `effect_by_arg`; the schema rejects it outright.

### 4.3 Current packages

The base deployment configuration `deploy/cloud/cloud.json` lists 14 packages plus `yimi`, the entry for packages Yimi builds herself:

| Package | Tools | Effect classes used | How it runs |
|---|---:|---|---|
| phone (phone errands) | 8 | observe, owner_data, workspace; by argument: send, account, physical, spend, delete | Dedicated process |
| mijia (Mijia smart home) | 6 | observe, physical, account | Dedicated process |
| owner-mac (remote Mac control) | 6 | observe, owner_data | Dedicated process |
| messaging (sending messages) | 2 | observe; by argument: send | Shared Python host |
| wechat-mac (WeChat on Mac) | 4 | observe, send | Shared Python host |
| desktop (Mac desktop assistant) | 16 | observe, owner_data | Platform TS service (HTTP) |
| ts-delivery / ts-erasure / ts-health / ts-location / ts-memory / ts-model-settings / ts-personal / ts-schedule | 3 / 3 / 1 / 5 / 9 / 2 / 5 / 2 | Declared per package, e.g. memory writes are owner_data, forgetting is delete | Platform TS service (HTTP) |

Small packages share one host process, `yimi_shared`, which starts only when needed and is reclaimed after 900 seconds idle; packages with long-lived state or heavy dependencies get their own process. When a self-built package is switched, the shared host emits `tools/list_changed` and Hermes refreshes its tool list without a restart. In a single-host deployment, Mijia, WeChat on Mac and the two Mac packages each have their own switch.

Once there are many tools, upstream Tool Search can load them on demand. An early measurement in an isolated environment at the scale of a few dozen tools found the same selection accuracy but slower runs (about +22% average latency, computed from the listed means; −34% tokens), so it is currently off.

## 5 Effect classes and gates

![Nine effect classes and their gates](../images/arch-02-effect-gates.svg)

*Figure 2 | Nine effect classes and their gates. The gate rules did not change; only the trigger did: the class is declared in the manifest instead of being self-reported by the model on every call.*

A few details:

- **Reads only check the role scope.** She may read even when the user has not asked, for example content inside a phone app.
- **"Was this explicitly requested?" is judged by the model.** The judgement goes to the gateway as the reserved parameter `owner_requested`; the execution adapter filters it out so it never reaches the underlying business call.
- **Actions not explicitly requested need confirmation**: `required = sending || !requested`. Only "sends the user explicitly asked for" are remembered, scoped to the same user, same recipient and same task type; a different person or a different kind of task asks again.
- **Starting, closing and stopping tasks on the cloud phone count as workspace** and show no card; saving and restoring the user's app login data goes through the "changes the user's things" gate.
- **Actions needing confirmation inside scheduled jobs are blocked outright**, so no card pops up when nobody is there.

## 6 Receipts and reporting

![The six kinds of facts in a receipt](../images/arch-03-receipt.svg)

*Figure 3 | The six kinds of facts in a receipt and the five invariants at the trust boundary.*

The same facts have three outlets:

1. **Activity cards**: status taken straight from the receipt, including `unknown` and `waiting`.
2. **Text and voice**: fact sentences are generated by the platform from fixed templates per fact kind (shorter for voice); content sentences are written by the model and carry judgement, advice and tone. Output is currently deduplicated by fact ID; limits on projection count, per-item length and array summaries are left to later versions.
3. **Deterministic check**: zero model calls. Before output it checks numbers, units, status words, the evidence behind "noted" and repetition; inconsistent sentences are removed, and missing facts are filled in with template sentences.

"What changed since last time" is based on actual delivery: a fact counts as "already said" only when the device returned a valid ACK (`rendered` for text, `played` for voice) and the reply covered by that ACK really carried the fact.

## 7 Devices and roles

| Device | What it does |
|---|---|
| iPhone | Text, voice, calls; on-device wake word "Yimi" (依米); Face ID for app lock, payment, settings changes and "it's me speaking for the next minute"; payment confirmation cards; voiceprint, health, location, contacts, model settings; pausing Mac control |
| Apple Watch | Talking on the watch, viewing cards and notifications, cycling and workout records; relayed through the phone |
| Mac | Desktop conversation, screen sharing; once paired, Yimi can read and write files, run commands and operate apps through an encrypted relay; a shortcut pauses this at any time; command log is reviewable; Touch ID confirmation; WeChat on Mac |
| Glasses (Android, RayNeo X3 Pro) | On-device wake word; first-person view; HUD cards; nod to confirm, shake to dismiss (gestures off while cycling); voice payment (opt-in) |

All devices share one timeline: the reply goes to the device where the sentence was said (the watch via the phone relay), and other devices pull the same records by sequence number. Switching devices does not mean starting over.

## 8 Voice: fast and slow thinking

- **Front end (fast thinking)**: a Qwen realtime voice model (default `qwen3.8-omni-flash-realtime`) listens and speaks. It answers small talk and simple general knowledge on the spot, checking public information first. When memory, private records, actions or deeper reasoning are needed, it calls `handoff_to_brain` to hand over to the main brain, with three fields: `difficulty`, `intent` and `thinking`.
- **Main brain (slow thinking)**: the Hermes main agent, which turns reasoning on or off for the turn according to `thinking`; execution goes to background subagents, and it relays the result when they finish.
- **Read-aloud**: Qwen TTS (default `qwen-audio-3.0-tts-plus`). Yimi's voice comes from Qwen's voice models, called through Alibaba Cloud DashScope.
- **Local models on the server**: voice activity detection, recognition, voiceprint, wake word and face recognition use local ONNX models.

Voiceprints are enrolled per capture channel, with default initial thresholds of 0.65 / 0.45. Face ID or Touch ID opens a 60-second trust window that vouches for one call; an anchor within the call recognises short utterances. Voiceprint verification thresholds are persisted per capture channel, never decrease and have a floor of 0.65. Automatic gradual increases require enough confirmed samples from the same channel; restarting or lowering the configured value does not lower a saved threshold.

## 9 Memory L1–L5

| Layer | Content | Authority |
|---|---|---|
| L1 | The current conversation and compressed context | Hermes native |
| L2 | Core profile `USER.md`, `MEMORY.md` | Generated by the platform from L3, read-only |
| L3 | Structured assertions with versions and dependencies | Platform (PostgreSQL) |
| L4 | Timeline and session history | Platform timeline; session history kept natively by Hermes |
| L5 | Raw audio, video frames and events | Platform: local hot storage + WebDAV cold packs |

- **Write**: after reading the evidence, a background subagent submits assertions with `paios_l3_commit` (effect class `owner_data`), using the expected version for compare-and-swap. When something upstream changes, downstream conclusions are marked for re-evaluation.
- **Forget**: `paios_l3_forget` (`delete`) recurses along dependencies, deletes the payloads of all versions and leaves a forgotten marker.
- **Read**: the main agent picks the layer according to the question. Calls also get a short context: six parallel reads, 1,200 ms each, 2,400 characters in total.

L5 processing and storage run on budgets: small archive batches, disk admission (4 GiB + 500,000 inodes), a cap on the analysis queue, yielding during calls, lossless compression for cold packs, controlled spacing between upload starts, and two verifications before a hot copy is deleted; hot copies are kept 2 days by default, configurable. See section 3.5 of the technical report.

## 10 Consent and payment

- **First-send confirmation**: the first send for the same user, same recipient and same task type needs confirmation.
- **Non-blocking confirmation**: an action that needs confirmation immediately returns a "waiting for your confirmation" receipt, and the subagent carries on with other work. After the user approves, the platform re-checks, executes exactly once, and starts a new turn to report the result.
- **Payment**: every payment is authorized separately and never remembered. By default the user taps a confirmation card on the phone (the phone must be unlocked; confirmation carries a device signature), and the authorization is valid for 60 seconds. Before tapping pay, the executor reads the checkout amount back; if it differs from the authorization, a new card replaces the old one, at most 2 times per intent by default.
- **Options (off by default)**: voiceprint payment, saying "pay" (「付吧」) on the phone or glasses, by default up to 200 yuan per payment and only to payees already paid before; small payments without confirmation, up to 50 yuan per payment and 150 yuan per day, provided no other payment to the same payee in the last 30 minutes was created as authorized, paying, paid or unknown, with a 5-second undo.
- **Ride hailing**: requires a ride permission sourced from the user; real rides are forbidden in test environments. Mijia door-lock devices are read-only.

## 11 Cloud deployment

![Cloud deployment](../images/arch-04-deploy.svg)

*Figure 4 | Containers on one Linux host.*

- Services are defined in `deploy/cloud/compose.yaml`, cold storage in `compose.archive.yaml`. The `production` and `staging` profiles use the same image with separate data volumes; the staging configuration replaces the phone and Mijia with local stand-ins. Full staging regression for kernel self-repair is still in progress.
- The only external entry is one TLS entry point, `front` (default 9443 in the base Compose, 8443 for the single-host entry), plus the WebRTC/TURN ports.
- `workshop` lives in its own Docker network: read-only root filesystem, 256 MiB memory, 0.5 CPU, at most 128 processes; its management entry goes through `workshop-link`, and its egress is further constrained by the workshop policy.
- Deployment secrets are mounted read-only under `/run/secrets/`, never in source or images; model-provider keys are stored encrypted by the model-settings authority, and package manifests contain only secret names.
- The single-host entry starts 7 services by default: gateway, hermes, front, postgres, livekit, workshop, workshop-link.
- Each host marks the current and previous versions with two pointers, `current` and `previous`, and the cleanup command keeps only those two. When `release-watchdog` finds a new version persistently unhealthy or restarting repeatedly, it switches back to the previous version.

**Model roles.** Main conversation, background subagents, vision, the voice front end, read-aloud, and the fast and slow tiers of the phone executor are each configured separately. In the example configuration, the brain and subagents use DeepSeek, vision uses GLM hosted on SiliconFlow, and the phone executor uses DeepSeek plus GLM. The user can change the provider and model of the everyday roles in iPhone or Mac settings. A change is saved as a draft first; after biometric confirmation on the device it takes effect when the current task ends (Face ID on iPhone, Touch ID on an authorized Mac). Yimi can only read and draft, not change it directly. Once a local catalog is configured, settings can switch speech recognition, voice activity detection, voiceprint, wake-word and embedding models after a device-signed approval, and show the selected and effective versions, the previous version, progress and errors. The deployer must configure `local_catalog_file` and supply model files, absolute paths and trusted digests; this entry point does not download models. Changing a speech model requires a service restart; changing the voiceprint model also requires re-enrollment and calibration for each capture channel in use. Embedding models need their own runtime environment and take effect only after derived indexes are rebuilt. Face models are listed, but switching them goes through the face-enrollment flow.

## 12 Cloud phone executor

The executor phone is an Alibaba Cloud Wuying AgentBay cloud phone by default. The phone package `phone` drives Mobilerun, and a model reads the screen step by step to decide what to do next. A task first takes a device lease, then runs preflight and preparation, then enters the model loop: 80 steps by default, 1–120 steps on request, and the model phase lasts at most 600 s by default (configurable). `CheckoutStop` wraps every tap and input: without a payment intent it will not enter payment; with a payment intent it stops at the checkout and hands over to the payment flow. On timeout or cancellation it first stops the workflow and waits for cleanup to finish, then releases the phone. The final state is written to disk atomically, and receipts carry the task ID and an increasing revision number. A task that fails and was not cancelled by the user automatically triggers one read-only self-check.

## 13 Self-growth

- **Building her own tools**: `capability_find` looks for existing ones → template → workshop build → registration checks (static checks + effect-honesty checks in a sandbox) → publish → per-package monitoring and automatic rollback. Packages Yimi builds may not declare `spend` or `self_change`; no extra go-live confirmation is added, and runtime gates apply as usual.
- **Repairing herself**: reproduce in the build workshop, find the root cause, minimal fix, add a regression test → ask the user once if a protected baseline is touched → immutable image, 7 offline test suites → re-check on the production host → switch when idle → watchdog. When Yimi changes the kernel, she first checks and syncs staging with production, then runs the regression in staging (in progress).
- **Learning from experience**: Hermes's native background review writes experience into skills; workshop tools cannot be changed directly and must go through the build and registration process.

**Speaking preferences.** Yimi can choose preset tone, expression and habit preferences in the platform preference area, up to 1,500 characters, and restore the previous version. The platform stores the versions and projects them into a read-only `memories/PERSONALITY.md`; preferences cannot change her identity, locked personality or protected rules.

**Optional meeting assistant (end-to-end work in progress).** This version provides optional meeting-assistant server orchestration and a presentation protocol, covering slide reads, locating text from the discussion, edit previews, first-edit consent and reconciliation of unknown results. Actual Keynote reads and writes require a Mac executor that implements this protocol and returns edit-readback evidence. The included Mac source does not yet implement these tools, so enabling the package alone does not make the assistant usable. Connecting such an executor also requires a configured platform port and internal service credentials, an authorized local file, and the specified Mac and one pair of glasses online. The protocol limits edits to replacing text and appending paragraphs; the default deployment does not enable the package.

## 14 In progress

| Capability | Status |
|---|---|
| Removing the residual kernel patch | In progress: still contains product logic such as run scopes and the main-agent division of labour |
| When Yimi changes the kernel, align with production first, then go through staging | In progress |
| Meeting assistant: read and edit local Keynote from the discussion | In progress: server orchestration and protocol exist; the included Mac source lacks the executor implementation |
| Assistants negotiating directly with each other (A2A) | In progress: the current public version has no complete A2A integration; treating outside agents as guests and confirming outbound sends first is a design boundary |
