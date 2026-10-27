# Yimi end-to-end flows

This document draws Yimi's seven most important flows one by one. Every flow follows three conventions:

- **Each step has exactly one owner.** The "Owner" column is the single authority for that step; everything else only reads it or keeps a snapshot.
- **No duplicate paths.** Each job takes one path: capability-package calls go through the capability gateway, ordinary effect confirmations through the consent authority, payments through the payment authority, and structured-assertion writes through platform L3.
- **Failure paths are drawn next to the happy path.** In the figures, red dashed lines are failure paths; the last column of each table says what the system does on failure.

For structure and terms see the [Technical plan](technical-plan.md); for mechanisms and numbers see the [Technical report](tech-report.md).

| ID | Flow | Starts with | Ends with |
|---|---|---|---|
| F1 | One sentence to a reply on its originating device, with multi-device sync | The user speaks or types on any device | The reply is shown or played on the device and recorded as delivered |
| F2 | One capability call | A subagent decides to call a tool | The receipt is recorded and the facts go to the model |
| F3 | First-time confirmation and payment confirmation | An action or payment that needs confirmation | Executed once, or truthfully cancelled |
| F4 | Yimi building her own capability | A wish or a missing capability | The package goes live; per-package monitoring and rollback |
| F5 | Self-repair and self-evolution of the kernel | A bug or an improvement | A new version goes live, or the attempt ends truthfully |
| F6 | Platform release and rollback | A candidate version | The new version is stable, or the previous one is back |
| F7 | Memory: from raw records to recall | One record on a device | An accurate recall, or one L3 assertion forgotten |

## F1 One sentence to a reply on its originating device, with multi-device sync

![From one sentence on a device to a reply](../images/flow-01-request.svg)

*Figure F1 | One sentence to a reply on its originating device, with multi-device sync.*

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Wake and upload | Device | Glasses, iPhone and Mac listen locally for "Yimi" (依米) with a Sherpa keyword model, then upload the speech; or the user sends text directly | Outside the wake or follow-up window it is only an ambient observation and does not enter the request path |
| 2 Transcribe and connect | Gateway | Validates the paired device's identity; for non-call input the Qwen realtime front end only transcribes, without answering or acting | Device identity mismatch: connection refused |
| 3 Admission and identity | Integration (admission) | Voiceprint decision uses saved per-capture-channel verification thresholds and sets the run scope; the original goes into L5; the sentence is written to the timeline | Identity unconfirmed or a guest: only tools for that scope are open; no private information is read and no errands are run |
| 4 Start the run | Integration → Hermes | `POST /v1/runs`; the run is bound to the admission record | Missing run binding: every later tool call is refused |
| 5 First answer and delegation | Main agent | First says what it will do next, then delegates asynchronously to a subagent; the turn ends | Async pool full or the session does not support async callbacks: delegate synchronously instead |
| 6 Act | Background subagent | Capability-package tool calls follow F2; native tools keep their own attachments | See F2 |
| 7 Result | Main agent | Writes the result from the receipt after the subagent finishes | Receipt is `unknown`: says truthfully "not sure yet" and checks first |
| 8 Check and send | Delivery (output) | After the deterministic check, sends the reply in chunks to the device where the sentence was said; voice is synthesized by Qwen TTS | Inconsistent sentences are removed and replaced with template fact sentences |
| 9 Delivered | Device → Delivery | The device returns an ACK: `rendered` for text, `played` for voice; the ledger marks only the facts covered by the ACK as said | No ACK: the facts do not count as delivered and appear as new facts in the next follow-up |
| 10 Multiple devices | Timeline | Other devices pull the same records by sequence number | Switching devices does not mean starting over |

**During calls** there is an extra fast-thinking layer: the front-end Qwen realtime voice model answers small talk and simple general knowledge itself, and when memory, private records, actions or deeper reasoning are needed it uses `handoff_to_brain` to hand over to the main agent; from there, steps 5–9 apply. Only turns from the user, not from guests, can hand over.

## F2 One capability call

![One capability call](../images/flow-02-capability-call.svg)

*Figure F2 | One capability call: decision, execution, receipt.*

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Intercept | Thin plugin `yimi-gateway` | `pre_tool_call` passes the tool name, arguments, task and call IDs to the gateway | Gateway unreachable: capability-package tools are always blocked, "not executed this time" |
| 2 Bind | Capability gateway | Determines user, run, scope and call origin (interactive, background, scheduled) from the admission record | Run already ended or not found: refused |
| 3 Rewrite arguments | Capability gateway | Injects trusted fields, overriding same-named model arguments; reads `owner_requested`, which the adapter filters out before execution | A required context field is not supported: refused |
| 4 Decide | Capability gateway | Scope → repeats and unknowns → class → gate | Scope mismatch, class cannot be resolved, already succeeded and no retry allowed, or an unchecked retry: blocked with the reason |
| 5 Gate | Consent / payment / release authority | Read-only and workspace pass directly; the other 7 classes go to their authorities per the table | Confirmation needed: go to F3 |
| 6 Execute | Capability package (MCP server) | Executes with the rewritten arguments and returns a `structuredContent` receipt plus a piece of text | Package error: normalized by the invariants in step 7 |
| 7 Record | Capability gateway + receipt ledger | Validates the schema and enforces the five invariants; records idempotently by (task ID, call ID) | Invalid receipt recorded as `unknown`; timeout or disconnect recorded as `unknown` with "check first"; a replay with different content returns a conflict |
| 8 Hand to the model | Capability gateway | Renders only the facts not yet delivered and replaces the tool result with them plus the normalized receipt | Gateway unreachable: the model is told "result not yet verified"; success is never assumed |
| 9 Observe | Capability gateway | `post_tool_call` only records latency and errors | An observation failure does not affect the recorded receipt |

## F3 First-time confirmation and payment confirmation

![First-time confirmation and payment confirmation](../images/flow-03-confirm-pay.svg)

*Figure F3 | Part A is an external action that needs confirmation; confirmation does not block the other tools in the same batch. Part B is payment; each payment is authorized separately.*

**Part A: actions that need confirmation**

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Decide whether to confirm | Consent authority | `required = sending \|\| !requested`; sends of a kind the user explicitly asked for before (same user, recipient, task type) pass directly | — |
| 2 Open a card | Capability gateway | Opens a confirmation card with class, target, content preview and deadline; immediately gives the subagent a `waiting` receipt | Inside a scheduled job: blocked outright, no card when nobody is there |
| 3 Carry on | Background subagent | Other tools in the same batch run as usual and are not held up | — |
| 4 User responds | The user's phone or glasses | Approve, reject, or time out | Reject or timeout: a `cancelled` receipt is recorded |
| 5 Re-check and execute | Capability gateway + consent authority | Re-checks once with the confirmation credential; an execution token guarantees a single execution | Re-check fails: `cancelled`; disconnect during execution: `unknown`, check first |
| 6 Report | Capability gateway → main agent | The result is recorded and a new turn tells the user | Only one follow-up per result (idempotent by event ID) |

**Part B: payment**

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Payment intent | Payment authority | The payment intent must come from this request, initiated by the user | Wrong source: refused |
| 2 Stop at checkout | Phone executor `CheckoutStop` | Within the same device lease, stops before paying and reads back amount and payee | Reaches the checkout without a payment intent: that tap is refused; stop and report |
| 3 Payment card | Payment authority → phone | By default confirmed on the unlocked phone with a device signature; optional voiceprint payment and small payments without confirmation (off by default) | Conditions not met: falls back to the phone confirmation card |
| 4 Authorize | Payment authority | One-time authorization, valid for 60 seconds | Expired: void |
| 5 Tap pay | Phone executor + payment authority | Reads the checkout amount once more before tapping; it must equal the authorization | Amount changed: old card voided and a new card issued, at most 2 times per intent by default, then stop |

## F4 Yimi building her own capability

![Yimi building her own capability](../images/flow-04-self-made-package.svg)

*Figure F4 | From a wish to going live and rolling back.*

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Hand off | Main agent | Hands the wish to a background build task | — |
| 2 Look for existing | Build subagent | `capability_find` searches installed packages, the Hermes skills hub and the official MCP registry | A search source is unavailable: carry on and note it in the result |
| 3 Reuse or build | Build subagent | If something fits, write only the manifest and receipt wrapper (≤200 lines); otherwise start from the template `yimi-capability-template` | — |
| 4 Build and self-test | Workshop | Separate network, read-only root filesystem, no mounts of everyday conversation or memory data volumes; can still read workshop snapshots, configuration and desktop input | Self-test fails: back to build |
| 5 Static checks | Package registry | Paths and portable formats, no secrets, manifest schema, no `spend`/`self_change`, stdio entry, required files, adapter ≤200 lines, size limits | Rejected with the reason; file contents are not echoed |
| 6 Effect-honesty check | Package registry (sandbox) | Runs the contract cases against both the fake and the real implementation; read-only tools may not write files; no sockets other than local ones; results must be valid receipts | Rejected with the reason |
| 7 Publish | Package registry | Checks the live version has not been changed; preloads, activates, refreshes the tool list without restarting Hermes | Activation fails: tries to restore the previous selection, otherwise reports the error |
| 8 Run | Capability gateway | External actions in the package still go through first-send confirmation and payment authorization | See F2, F3 |
| 9 Monitor | Package registry | Health checks in each maintenance cycle, and a Wilson interval comparison of the "failed + unknown" rate between new and old versions | Health fails or a clear regression: automatic per-package rollback |
| 10 Undo | User → Yimi | The user says they do not want this version; Yimi calls `skills_hub(action="revert")` | First version: the package is removed |

This publishing flow for self-built packages does not go through staging and adds no go-live confirmation; isolation, registration checks and per-package rollback are still all required.

## F5 Self-repair and self-evolution of the kernel

![Self-repair and self-evolution of the kernel](../images/flow-05-self-repair.svg)

*Figure F5 | Dashed boxes are steps in progress.*

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Triage | Main agent | Wording, habits and skills are changed on the spot; product code or the kernel goes to the build workshop | — |
| 2 Align (in progress) | Release flow | Compares staging with production: code commit, native code tree, service images, skills, capability packages, configuration structure, data snapshot; syncs first if they differ | Still different after syncing: stop; never change on a stale base |
| 3 Fix | Build workshop | Reproduce → root cause → minimal fix at the source → a regression test that fails before and passes after; patch ≤1 MiB; first line written so the user can understand it | Cannot reproduce or cannot fix: tell the user truthfully |
| 4 Protected baselines | Release flow | Checks whether payment, real taps and ride hailing, first-send confirmation, identity, care and guest permissions, secrets and sandbox, remote Mac access, release and rollback, or the persona's "most fundamental rule" are touched | Touched: ask the user once with a confirmation card; if refused, end truthfully |
| 5 Build and test | Release flow | Immutable image; 7 test suites, offline, read-only root filesystem; gate $F_{\text{cand}}\setminus F_{\text{base}}=\varnothing$ | New failures, or a non-zero exit code with no parsable failures: rejected |
| 6 Staging (in progress) | Release flow | Runs the full system on the latest snapshot, with every external action caught by stand-ins | Regression fails: rejected |
| 7 Re-check | Production host | The base must equal the commit live right now | Not equal: void; redo the fix on the current live version |
| 8 Wait for idle | Production host | No calls, no runs or background delegations, no session write leases or compression locks, no phone tasks, no fault logs in 5 minutes, no out-of-memory | Not idle: keep waiting |
| 9 Switch | Production host | Back up the database → stop writes → switch the pointer → start → verify images and health | Verification fails: back to the previous version |
| 10 Watchdog and notice | Watchdog | Takes over watching the new version; a system message tells the user what was fixed | See F6 |

## F6 Platform release and rollback

![Platform release and rollback](../images/flow-06-release.svg)

*Figure F6 | Release, automatic rollback and user-requested rollback.*

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Candidate | Release flow | Builds an immutable image; offline tests show no new failures | Rejected |
| 2 Re-check and wait for idle | Production host | Same as F5 steps 7 and 8 | Same as above |
| 3 Switch | Production host | Back up the database, stop writes; `previous ← current`, `current ← candidate`; start and verify | Verification fails: back to the previous version |
| 4 Watch | Watchdog (independent of Yimi) | Records the start of unhealthiness $t_b$ and the restart count $R_W$ within window $W$; notifies the user if it stays healthy | $t-t_b\ge U$ or $R_W\ge L$: write the rollback intent first, then switch back to the previous version, one attempt only |
| 5 Step aside | Watchdog | A third image appears, meaning a newer release has taken over | Stop this rollback; do not overwrite the newer release |
| 6 User-requested rollback | Yimi → production host | `skills_hub(action="release_rollback")` with the user's own words as the reason; switches back at the next idle moment | The running version is not the one brought up by the latest switch: refused with the reason |
| 7 Cleanup | Production host | The cleanup command keeps only the current and previous versions | — |

There are two boundaries. First, rollback swaps only programs and configuration; it does not restore the database or undo external actions that already happened. Second, $U$, $W$ and $L$ have no built-in defaults and must be configured from measured switch and health-check durations.

## F7 Memory: from raw records to recall

![Memory: from raw records to recall](../images/flow-07-memory.svg)

*Figure F7 | Memory from originals to recall, and forgetting.*

| Step | Owner | What it does | On failure |
|---|---|---|---|
| 1 Original | Platform memory (L5) | Device events are written to disk as-is; audio first passes disk admission (4 GiB + 500,000 inodes) | Not enough room: reclaim and check again; if still not enough, report truthfully "not written to disk" |
| 2 Timeline | Platform memory (L4) | Every sentence is written to the timeline with a sequence number; devices sync it page by page | — |
| 3 Assertion | Background subagent → platform memory (L3) | After reading the evidence, submits with `paios_l3_commit` using the expected version for compare-and-swap; writes dependencies | Version mismatch: conflict, re-read and decide again; a forgotten ID: refused |
| 4 Invalidate | Platform memory (L3) | When something upstream changes, current downstream conclusions are marked `needs_reevaluation`, not negated | — |
| 5 Core profile | Platform memory (L2) | Generates `USER.md` and `MEMORY.md` from `core_profile.entry` assertions, read-only | — |
| 6 Every turn | Memory provider `personal_aios` | Hermes prefetches the core profile every turn | — |
| 7 Recall on demand | Background subagent | Picks the layer by question: L3 query, L5 originals, visual recall (RRF, at most 100 items per list) | Original already deleted: skipped, not backfilled |
| 8 Short context in calls | Platform | Six parallel reads, at most 1,200 ms each, 2,400 characters in total | One read times out: use the others |
| 9 Forget | Platform L3 memory | `paios_l3_forget` recurses along dependencies, deletes all version payloads and leaves a forgotten marker | L3 payloads not fully deleted: error; no claim that L4, L5 or backups were deleted on this basis |
| 10 Cold storage | Platform memory (L5) | Lossless cold packs, verified once after upload and once before the hot copy is deleted | Verification fails: alert; not a single hot copy of that pack is deleted |
