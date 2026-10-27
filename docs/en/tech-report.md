# An always-on assistant that grows by itself: the Yimi technical report

October 2026

Imagine a few years from now: everyone has an assistant of their own. She knows your voice, remembers what you have said, can use every app on your phone, and can also work the lights in your home and the files on your computer. When you want to have dinner with a friend, you no longer open three apps to compare times and restaurants; your assistant talks to your friend's assistant, the two settle it, and you both just nod at the end. By then, the platform layer that sits between people and services will slowly grow thinner.

Yimi is a first step in that direction. She is a personal AI living in an iPhone, an Apple Watch, a Mac and Android glasses, one system per person, running as containers on the user's own Linux cloud host, with the model being just a configuration item. The project started in October 2026. This report explains one thing: what technical problems an assistant has to solve to stay with you all day, be the same "her" on every device, and keep getting better by herself, and how we solved them.

The report has four parts. Part one is the skeleton: aiming not to modify the upstream kernel (in progress), capabilities in one format, "capability packages", and a structured receipt left by every call. Part two is always-on operation: recognising who is speaking, acting while talking, correctable memory, truthful reporting, and bounded data. Part three is self-growth: building her own tools, repairing herself, and learning from experience. The last part is what comes next. Each section starts with a scene, then goes into mechanisms, formulas and measured numbers.

What follows is based on the public 0.1.5 code. Historical numbers are all labelled as early measurements; code that is wired up is not the same as accepted in production.

## 1. A day with Yimi

Start with a demo scene; the order and the conversation in it are fictional.

In the morning, the user puts on his glasses and heads out. At a street corner he says: "Yimi, order a milk tea, same as last time." The glasses hear the wake word locally and send the speech to the server. Yimi replies, "OK, I'll place the order and stop before payment to wait for you," and hands the ordering to the background. He goes on to ask whether it will rain tomorrow, and she answers as usual. A dozen or so minutes later, a payment confirmation card appears on his phone; he checks the amount and confirms it himself.

In the afternoon he says, "From now on, tell me as soon as a parcel arrives." Yimi has no ready-made tool for checking this, so she builds a capability package herself, puts it live after it passes the registration checks, and attaches a scheduled check. In the evening he tells her that a backend query endpoint is throwing errors. She can hand this to the code-repair flow (the end-to-end flow of aligning staging before a kernel change and completing staging regression is still in progress). If he does not like the new version, a casual remark that he wants the previous one back is enough.

This day hides three kinds of hard problems. The first is the skeleton: dozens of capabilities must plug in the same way, every action must pass the right gate, and every result must be reported accurately. The second runs through every minute: which sentence did the user himself say, the conversation must not stop while an order is being placed, outdated judgements must be correctable, and a full day of audio and video must fit in storage. The third spans many days: a capability missing today must be filled in by herself tomorrow; errors she finds must be fixed by herself, and a bad fix must not take her down.

![Yimi's overall structure](../images/arch-01-overview.svg)

*Figure 1 | Yimi's overall structure. At the top are the four kinds of devices, which enter the platform services through the single TLS entry point; the platform services are the single authority for product rules and facts; Hermes connects to the platform through attachments and still carries a temporary residual patch; capability packages connect to the kernel as MCP servers, and some legacy attachments remain during the transition.*

## 2. The skeleton: capabilities as packages, kernel patch removal in progress

### 2.1 Early records: the boundaries of capabilities and reporting

Yimi's brain is the open-source Hermes Agent. The early plan recorded a patch of 13,841 lines touching 145 upstream files; capabilities were also scattered across four forms: of 105 tool identities, 37 were MCP tools, 32 Hermes native tools, 30 TypeScript contracts and 6 Python plugin tools.

The early plan also recorded two shortcomings. First, the model reported the effect class itself on every call; when it reported wrong, the gate decided wrong. Second, two batches of answers under the same reporting rules scored 72 once and 35 once on semantic grading. These are early records, not measurements of the current version.

### 2.2 Cause: the rules lived in the wrong place

These problems share one boundary: product rules were written where they did not belong. Who may act, whether confirmation is needed and what to tell the user should be decided by the platform, yet these rules were scattered across the kernel patch, model prompts and each tool's private format. When rules have no single home, facts have no single source.

### 2.3 Approach: one authority, one format, two fixed classifications

We split the structure into three layers (Figure 1).

**The kernel is the kernel.** Hermes is based on the pinned upstream v0.22.5 commit `bf0203a` and still carries a temporary residual patch. Capability packages and memory connect to the platform mainly through three attachments:

1. The thin plugin `yimi-gateway` (133 lines), which registers three documented tool hooks (`pre_tool_call`, `transform_tool_result` and `post_tool_call`) plus nine lifecycle hooks;
2. The memory provider `personal_aios`, an upstream `MemoryProvider`, with platform memory as the single authority;
3. Package loading: at deploy time, each package's manifest is turned into Hermes MCP server configuration.

The transitional residual patch is marked temporary, and the goal is to remove it entirely (in progress); it still contains product logic such as run scopes and the main-agent division of labour. The patch is now 11,972 lines (actual changes +6,437/−964 lines across 151 files), 1,869 lines fewer than the 13,841 in the early record. The `personal_aios` attachment also still holds some tool and middleware registrations that have not all moved into the thin plugin yet.

**The platform services are the single authority.** Identity and admission, consent and payment, timeline and memory, delivery, voice and activity cards all live in the platform services. The new "capability gateway" lives there too, handling call decisions, the receipt ledger, fact sentences and report checking.

**Capabilities use the package format.** Migrated capabilities are capability packages in the Agent Plugins v1 format that upstream already supports: a `plugin.json` manifest at the root, an optional `mcp.json`, a `SKILL.md` under `skills/`, the service code, a `fake/` implementation and `tests/contract.yaml` contract tests. Our own fields go in the manifest's extension block `extensions["ai.yimi.capability"]`; no new format is invented. The base deployment configuration lists 14 packages: phone errands, Mijia, remote Mac control, the Mac desktop assistant, WeChat on Mac, messaging, and eight platform TS capabilities (delivery, erasure, health, location, memory, model settings, people and profile, schedule), plus the entry for packages Yimi builds herself.

The most important thing in a manifest is the **effect class** each tool declares. There are 9 classes, each mapped to the corresponding existing decision (Table 1). When calling, the model fills in only business arguments and no longer reports a class; the class is either fixed per tool or chosen by the value of one argument, for example `action=list` on the messaging tool is only a read. If an argument value maps to no class, the gateway blocks the call; there is no guessed default.

*Table 1 | Effect classes and their gates*

| Class | Meaning | Gate |
|---|---|---|
| observe | Read-only | Role scope check only |
| workspace | Output only in Yimi's own workspace | Role scope check only; isolation itself is the safety measure |
| owner_data | Changes the user's files, memory, settings | Done directly if the user explicitly asked, otherwise confirmed each time |
| send | Sends content to a person, a group or another agent | First-send confirmation: by user, recipient and task type |
| account | Login, authorization, account changes | Done directly if the user explicitly asked, otherwise confirmed each time |
| delete | Irreversible deletion | Done directly if the user explicitly asked, otherwise confirmed each time |
| physical | Acts on the real world: devices, ride hailing | Consent plus ride permission; no real rides in test environments; door locks read-only |
| spend | Spends money | Per-payment authorization plus checkout amount check, never "remembered" |
| self_change | Changes Yimi herself | Release authority; asks the user only when a protected baseline is touched |

"Was this explicitly requested by the user?" is still judged by the model. The judgement goes to the gateway as the reserved parameter `owner_requested`, and the gateway uses it to decide whether confirmation is needed; afterwards the execution adapter of the frozen call or the package filters it out, so it never reaches the underlying business call. Neither identity nor "the user started this turn" can replace this judgement; otherwise the baseline would quietly loosen.

### 2.4 Where a call goes

Figure 2 is the full sequence of one capability call. When a subagent decides to call a tool, Hermes first fires `pre_tool_call`, and the thin plugin passes the call over loopback to the gateway's `decide`, with a 3-second timeout. From the admission record, the gateway finds which user and scope this run belongs to, then decides in order:

1. Scope: if the tool's manifest does not list the current scope (user, identity unconfirmed, guest, build, care), block;
2. Repeats and unknowns: if the same call fingerprint has already succeeded and the receipt declares `retry=forbidden`, block and say "this operation already succeeded"; if the previous result was `unknown` or `partial` and requires checking first, block until a check with the read tool named in the receipt's `check_with`;
3. Class: resolve this call's class from the manifest; if it cannot be resolved, block;
4. Gate: read-only and workspace pass directly; the other 7 classes go to the consent, payment or release authority.

When allowing a call, the gateway injects trusted fields such as session, run, call ID and idempotency key into the arguments, overriding same-named arguments from the model, and returns them as a "rewrite". Three separately hand-written identity bindings thus merge into one.

![One capability call](../images/flow-02-capability-call.svg)

*Figure 2 | Decision, execution and receipt of one capability call. When the gateway is unreachable, calls are always blocked before execution, and after execution the model is told "result not yet verified".*

### 2.5 Receipts: six kinds of facts, five invariants

After a tool runs, the result is normalized into one receipt, placed in MCP's `structuredContent` with a piece of text alongside. A receipt has six kinds of facts (Figure 3): ① status, with 9 values; ② effects, what was done to whom, with four verification levels `verified`, `service_ack`, `not_verified`, `unknown`; ③ values and content, where every value must carry a unit and a source; ④ things not known; ⑤ next-step permissions: whether retrying is allowed, what to check first, who is being waited on; ⑥ what changed since last time. The first five are filled in by the package; the sixth is computed by the system, never by the package.

![The six kinds of facts in a receipt](../images/arch-03-receipt.svg)

*Figure 3 | The six kinds of facts in a receipt and the five invariants at the trust boundary.*

Upstream passes `structuredContent` to the model as-is but does not validate its schema, so the platform validates it once at the trust boundary and enforces five invariants. The core principle is to downgrade only, never upgrade:

1. Status says "success" but some effects are unverified: partially verified becomes `partial`, nothing verified becomes `unknown`, and a "self-contradiction" is recorded;
2. A failure reason containing `TIMEOUT` or `DISCONNECTED` is always recorded as `unknown`, and the next step becomes "check first", because a timeout does not prove failure;
3. A value without a unit is a contract violation;
4. A package writing `rejected` itself is changed to `unknown`: "blocked by a gate, never executed" can only be written by the gateway;
5. Anything that is not a valid receipt is recorded as `unknown`; a "success" flag in a legacy format does not count as evidence.

Receipts are written to the ledger idempotently by (task ID, call ID): when the same call is replayed, a matching content fingerprint returns the original record, and a mismatch returns a conflict. Long tasks (such as phone errands) carry a task ID and a strictly increasing revision number. The ledger's current projection takes the latest revision of each task, and historical receipts are kept. Task status itself still belongs to the executor; the ledger does not take over that ownership.

### 2.6 Results

- A new capability only needs to take its slot: write a manifest, declare classes, return receipts; no kernel changes and no extra reporting rules.
- The trigger for the gates changed; not one of the gate rules did.
- Packages start on demand and are reclaimed after 15 minutes idle. Early measurement in an isolated environment: with 10 package servers in use at once, about 141 MiB of memory in total, and zero processes after idle reclaim.
- Once there are many tools, upstream Tool Search can load them on demand. Early on, in the same isolated environment, 80 real model runs picked the right tool 40/40 both with and without it; with it on, average latency went from 8.9 seconds to 10.9 seconds (about +22%, computed from the listed means), and tokens fell by 34%. With only a few dozen tools it is not worth it, so it stays off for now, until there are enough packages that context gets noticeably tight.

## 3. Always on

Always on means input keeps coming and actions keep happening. The next five sections answer in turn: who is speaking, how to act while talking, how memory stays correct, how to report truthfully, and how data stays within budget.

### 3.1 First recognise that the speaker is the user

The glasses and phone pick up sound all day: the user himself, passers-by, the TV, and Yimi's own answers coming out of the speaker. Only the user himself can have her run errands or read his private information. For every sentence that comes in, the platform first assigns a run scope: the user `owner`, identity unconfirmed `owner_uncertain`, or guest `guest`. The scope decides which tools are visible in that turn.

**Early shortcoming.** When the user's own call audio was sent for recognition, 33 of 41 requests returned unknown and 8 returned uncertain; not once was he recognised as himself. The similarity of the scored speech ranged from 0.4608 to 0.5467, all below the threshold for confirming the user (Figure 4).

![Early recognition results](../images/rep-02-voice-early.svg)

*Figure 4 | Early recognition results for the user's own call audio.*

**Early measurement of channel differences.** Change the channel and the score drops sharply. For the same person, an m4a recorded with the phone's built-in recorder app scored only 0.42 against voice captured through the app pipeline; within the same channel, pairwise similarity of the user's own speech ranged from 0.69 to 0.89. These numbers come from the early report's measurement records. They suggest that channel differences may affect decisions, but they alone cannot establish why the 41 requests above failed.

**Approach.** Three directions.

First, enroll per capture channel: one set each for the phone app, the glasses and the Mac. Each valid speech segment is at least 1,500 ms, with at least 5 and at most 20 segments per channel. The enrollment centroid is weighted by duration and quality. Let segment $i$'s normalized embedding be $\hat x_i$, its voiced duration $d_i$ and its quality $q_i$ (default 1):

$$
c=\frac{\sum_i d_i q_i \hat x_i}{\left\|\sum_i d_i q_i \hat x_i\right\|_2},\qquad
s(x)=\max_{\text{channel } k}\ \cos\!\left(x, c_k\right)
$$

When all five segments are 1,500 ms with equal quality, the weights cancel out in normalization; replace one of them with a 3,000 ms segment and its pull on the direction doubles. Before enrollment there is a leave-one-out check: each segment is compared with the centroid of the remaining samples, and if any one has a cosine below 0.6, the whole set is not enrolled. The leave-one-out check is done only within one channel, because the same person across channels also scores only 0.42. At recognition time the maximum score across channels is taken and falls into one of three bands: $s\ge0.65$ is verified, $0.45\le s<0.65$ is uncertain, $s<0.45$ is unmatched.

Second, use on-device biometrics to vouch for a call. When the user taps "it's me speaking for the next minute" on the phone and passes Face ID, or passes Touch ID on the Mac, the platform opens a 60-second trust window for that device. A call with speech arriving inside the window is bound until hang-up: apart from Yimi's own echo, all speech in that call is treated as the user, with permissions valid only for that call. Speech in the window that is at least 1,000 ms long with quality at least 0.5 also becomes a learning sample: the first segment sets an anchor, and each later segment must reach a cosine of 0.65 against both the anchor and the existing learning set.

Third, use an in-call anchor for short utterances. Answers like "yes" or "wait a moment" are too short to compare reliably against the long-term enrollment. As soon as one sentence in a call is confirmed as the user by voiceprint (not by the trust window), its embedding becomes an anchor; later speech that the long-term enrollment cannot decide is compared with the anchor if its voiced part is at least 200 ms, and a cosine of 0.65 or more is treated as the user. This too is limited to the call and deleted on hang-up.

Figure 5 shows the trunk of the user decision, omitting branches such as matching known other people. There are two more boundaries: payment and interruption modes do not use the trust window, and payment does not accept a "this call only" identity; automatic learning stops accumulating once a channel has 20 segments, with no rolling replacement, so that one misjudgement never becomes the basis for the next round of learning.

![Speaker decision](../images/rep-03-voice-decide.svg)

*Figure 5 | Speaker decision for one sentence. The dashed line is the anchor re-check valid only within the call.*

**Results.** We deliberately avoid the closed-set rule "whoever scores highest is the speaker": there are always guests, the TV and echo around, and admitting "I don't recognise this" is safer than forcing a voice onto someone. Voiceprint verification thresholds are persisted per capture channel, never decrease and have a floor of 0.65. Automatic gradual increases require enough confirmed samples from the same channel; restarting or lowering the configured value does not lower a saved threshold. This describes the threshold-update rule, not accepted misrecognition or recall performance.

### 3.2 Talking while getting things done

During a call, the user says "book me a table for seven tomorrow evening," and right after, "by the window." Booking may take several minutes; if the assistant had to finish the first thing before taking the second sentence, the call would stall.

Our answer is "fast thinking × slow thinking" (Figure 6). The front end is Qwen's realtime voice model `qwen3.8-omni-flash-realtime`, which listens and speaks and answers small talk and simple general knowledge on the spot. When it needs to read memory, check private records, perform actions or reason deeply, it calls `handoff_to_brain` to hand over to the main brain with three fields: `difficulty` says what makes it hard, `intent` keeps the key conditions from the original words, and `thinking` decides whether the main brain turns on deep reasoning for this turn. Only turns from the user, not from guests, can hand over.

The main brain is Hermes's main agent. It only converses, judges, reads the memory the conversation needs and states goals; anything that requires action, even a single tool, goes to a native asynchronous subagent.

This division does not rely on the model's self-discipline. In the residual patch, the `CONVERSATION_TOOLS` whitelist and `restrict_agent` narrow the tool catalogue of a root agent configured with a delegation toolset, so execution tools are invisible to it; this is done by the residual patch, not the thin plugin. Once an asynchronous delegation is accepted, the main agent ends the turn with `delegation_waiting`. If the async pool is full, or the current session does not support async callbacks, the delegation runs synchronously instead.

While waiting, the user's additions are forwarded to the original subagent via `delegate_task(action="steer")` and arrive at the next tool-result boundary; if the subagent finishes first, any undelivered additions come back with the completion result, and the main agent decides what to do next. Scale is capped: at most 3 subagents at once, and spawning at most 2 levels deep.

![Fast and slow thinking](../images/rep-04-fast-slow.svg)

*Figure 6 | One fast × slow thinking handoff. In the parallel region, the background works on the first task while the front end takes the second sentence.*

The risk of background parallelism is a task tree that calls tools without end, so one run shares one budget. Let the parent agent use $u_0$ calls and the subagents $u_1,\dots,u_m$ calls; the production limit is:

$$
\sum_{i=0}^{m} u_i \le 120
$$

The count is decremented under a lock, and calls that fail argument validation count too. Every 20 calls, the system inserts a milestone prompt asking the model to state progress and blockers against the original goal; with no concrete next step, it must change approach or report.

### 3.3 Remembering, and being able to change it

The user once said he does not eat coriander, so when ordering takeaway Yimi adds the note "no coriander". Today he says he can eat coriander now. What needs changing is not just that preference, but also the conclusions derived from it.

Memory has five layers:

| Layer | Content | Question it answers | Authority |
|---|---|---|---|
| L1 | The current conversation and compressed context | What are we talking about now | Hermes native |
| L2 | Core profile: `USER.md` and `MEMORY.md` | Stable key facts about him | Generated by the platform, read-only |
| L3 | Structured assertions with versions and dependencies | What is believed now, and on what basis | Platform |
| L4 | Timeline and session history | How it was said at the time | Platform timeline; session history kept natively by Hermes |
| L5 | Raw audio, video frames and events | What the raw evidence is | Platform |

**Early shortcoming → how we changed it.** L2 used to be two native Hermes notes, written directly by the model and background review, a second set of facts alongside platform memory. Native memory writes are now off. L2 is generated by the platform from L3 assertions whose predicate is `core_profile.entry` and handed to Hermes as read-only files, and the memory attachment brings them into context every turn as the "platform core profile". Memory now has a single authority.

L3 is the heart of correctable memory (Figure 7). Every assertion has a version number and dependencies, which point to specific versions of upstream assertions. A change request must carry the version $e$ that the caller believes is current. The commit happens in one database transaction, taking a per-user advisory lock first; let $h$ be the current version read by the transaction and $v$ the new version:

$$
h=e \Rightarrow h'=v,\qquad h\ne e \Rightarrow \text{conflict}
$$

If two changes both start from version 7, the first to commit moves it to 8; the later one finds $8\ne7$, gets a conflict, and must re-read and decide again. If the same request arrives again because of a network retry, it hits the receipt and does not write two versions.

![Versioned commit of assertions](../images/rep-05-l3-commit.svg)

*Figure 7 | Versioned commit of assertions and dependency invalidation.*

When something upstream changes, current conclusions affected along the dependency chain are marked `needs_reevaluation`. The mark only means "needs to be judged again"; it never negates the conclusion automatically: once "note: no coriander" is marked, the model reads the material and recommits it the next time takeaway is ordered. On forgetting, the system uses a recursive query to find assertions affected along all historical dependencies, deletes the payloads of all their versions and leaves a forgotten marker; recommitting the same ID is refused.

Memories brought by the glasses can also be asked another way: "What was that shop just now called?" Image similarity and text-match scores are not on the same scale, so only ranks are used, in reciprocal rank fusion, with rank $i$ starting at 0:

$$
\operatorname{RRF}(x)=\sum_{j:\,x\in L_j}\frac{1}{60+i_j(x)}
$$

If the image list is ordered A, B, C and the text list B, C, A, then B scores $1/61+1/60\approx0.03306$ and A scores $1/60+1/62\approx0.03280$. B is near the top of both lists, so it comes first. Each list contributes at most 100 items; entries whose originals have been deleted are skipped and not backfilled.

Calls also get a short context: profile, notes, assertions, recent timeline, time zone and health are read in six parallel reads, each waiting at most 1,200 ms, 2,400 characters in total.

### 3.4 Acting for him, and reporting truthfully

"Order a milk tea, same as last time" has to land on a phone: open the app, find the shop, choose the options, stop before payment. The executor phone is an Alibaba Cloud Wuying AgentBay cloud phone by default, and Mobilerun's model reads the screen step by step to decide what to do next. No fixed tap script is written; one app redesign would break a script.

**Execution.** A phone task first takes a device lease (an in-process mutex plus a per-device file lock), so only one task operates the phone at a time. Then come preflight, unlocking and preparation, and then the model loop: 80 steps by default, requested step limits clamped to 1–120, and the model phase lasts at most 600 s by default (configurable).

The executor wraps the phone driver in `CheckoutStop`: without a payment intent, if the screen enters a checkout or the button the model wants to tap would charge directly, that tap is refused and the task is told to stop and report the merchant, options, amount and estimated time; with a payment intent, it stops before the payment action and hands over to the payment flow within the same lease. The decision looks at the tap target and the payment controls on the page, not at the model's understanding of the whole page. On timeout or cancellation, it first cancels the workflow and waits until the in-flight taps and inputs have really finished cleaning up, then releases the phone; otherwise a leftover tap would land on the next task's screen (Figure 8).

![Lifecycle of a phone errand](../images/rep-08-errand.svg)

*Figure 8 | Lifecycle of one phone errand.*

**Early measurement record.** The early report recorded a simulated order where the task had already returned completed, but the reply said "still waiting for confirmation". Now every party reads the same final state on disk: when a task ends it writes a temp file, fsyncs, atomically renames it to the final-state file, fsyncs the directory, and only then deletes the "running" marker; duplicate checks and status queries share one reader. Every status snapshot of the phone package is itself a receipt, with the task ID and an increasing revision number. A task that fails and was not cancelled by the user automatically triggers one read-only self-check, without re-dispatching the original task.

**Early shortcoming: facts get misreported.** Even with structured facts, the step where the model restates them is still unreliable; that is what the 72 and 35 scores in section 2.1 show. We split reporting into two parts (Figure 9):

- **Fact sentences are spoken by the system.** The platform generates them from fixed templates per fact kind; templates are written per kind, not per tool, so their number is fixed; the voice version is shorter.
- **Content sentences are written by the model.** They carry judgement, advice, questions and tone, do not repeat status, and any number they cite must come from the receipt.
- **A deterministic check as the backstop.** Zero model calls. Each sentence is checked for numbers and units (Chinese numerals are converted to Arabic first) and for status words like "done / failed / still working / noted" matching the receipt; suggesting to redo something marked `retry=forbidden`, saying "noted" without a verified "user data" or "workspace" effect, and repeating facts already said are all removed, and missing facts are filled in with template sentences.

![Three outlets for the same facts](../images/rep-07-report-check.svg)

*Figure 9 | Three outlets for the same facts: activity card, text, voice; the deterministic check guards them before output.*

"What changed since last time" must be based on actual delivery. The ledger keeps a set of "delivered facts" per user; a fact counts as "already said" only when the device returned a valid ACK (`rendered` for text, `played` for voice) and the part of the reply covered by the ACK really carried that fact. Facts without an ACK because the network glitched appear as new facts in the next follow-up.

Fact sentences are currently output after deduplication by fact ID, and there is no separate limit yet on how many items are shown or how long each is. Limits on projection count, per-item length and array summaries are left to later versions.

**Confirmation does not block.** Early on, upstream native approval was measured in an isolated environment: approve, reject, a response within 75 seconds and a 90-second timeout all behaved as expected; but as long as one tool in a batch was waiting for approval, the tools after it were held up too. So confirmation became non-blocking: for an action that needs the user's confirmation, the gateway immediately returns a `waiting` receipt, "waiting for your confirmation, not executed this time", and the subagent carries on with the rest of the batch; after the user approves on the phone or glasses, the platform re-checks once with the confirmation credential, uses an execution token to guarantee a single execution, and starts a new turn to tell him the result. Rejection or timeout is recorded as `cancelled`; inside scheduled jobs, actions that need confirmation are blocked outright, so no card pops up when nobody is there.

**Every payment stands alone.** Payment is always authorized each time and never "remembered". By default the user taps a confirmation card on the phone; the phone must be unlocked and the confirmation carries a device signature; the authorization is single-use and valid for 60 seconds. Before tapping pay, the executor reads back the checkout amount; if it differs from the authorized amount, the old card is voided and a new one issued, at most 2 times per payment intent by default. The user can turn on two more options, both off by default: voiceprint payment (saying "pay" (「付吧」) on the phone or glasses, by default only to payees already paid before and up to 200 yuan per payment) and small payments without confirmation (up to 50 yuan per payment and 150 yuan per day, provided no other payment to the same payee in the last 30 minutes was created as authorized, paying, paid or unknown, with a 5-second undo window).

### 3.5 A full day of data must not crush her

With companion mode on all day, sound alone adds up. Devices send 16 kHz, 16-bit, mono PCM: 32,000 bytes per second, about 115.2 MB per hour. Without budgets, memory, disk or analysis compute will fill up sooner or later, and that moment is often exactly when the user is talking to her (Figure 10).

The same audio stream goes two ways. The realtime copy goes straight to the front end; the archive copy is collected into small batches before writing, one write per 500 ms, 20 frames or 64 KiB, whichever comes first. Only after the original is safely written does it enter background analysis. The analysis queue has fixed caps: at most 2 continuous streams, at most 64 pending chunks per stream, and at most 32 candidates in total. Continuous speech is cut into chunks of 160,000 samples (10 s), with 8,000 samples (0.5 s) of overlap between neighbouring chunks. When the user is on a call, analysis yields. Speech recognised from the environment is written to an ambient log with its source; building recent context takes only the last 600 s, with an encoding budget of 12,000 bytes. Unless it enters the request path through the wake word or a follow-up window, it is only an observation and carries no command authority.

![Bounded processing and storage](../images/rep-09-bounded-media.svg)

*Figure 10 | Bounded processing and storage of a full day of audio.*

Disk admission looks at both free bytes and free inodes; the deployment configuration reserves 4 GiB and 500,000 inodes. To write 8 MiB:

$$
B_{\text{avail}} \ge 4{,}294{,}967{,}296 + 8{,}388{,}608,\qquad I_{\text{free}} \ge 500{,}000
$$

Even with 5 GiB of disk left, the write is refused if inodes run short. When admission fails, the system reclaims and checks once more; if there is still not enough, it reports truthfully "this original has not been written to disk yet" instead of pretending it was written.

Cold storage uses only lossless compression: a sentence that cannot be recognised today will need the original audio for re-analysis with a future model. 16-bit PCM chunks use FLAC, everything else gzip level 1; FLAC encoding and decoding go to a low-priority, single-threaded ffmpeg process, at most 30 s per run. A cold pack starts with 8 bytes, the marker `L5P1` and the header length, followed by a gzip-compressed canonical JSON header, then the data chunks; the header records each chunk's encoding, offset, size, decoded size and SHA-256, and reading one object fetches only its chunk with an HTTP range request. A pack is at most 64 MiB decoded and 80 MiB in transfer, and the header is at most 1 MiB both before and after compression.

**Current migration boundaries.** Each round of cold-storage migration packs at most two packs, each with at most 2,048 objects, usually sealing at about 8 MiB; discovery covers at most 8,192 candidates, sharing a 5 s soft work budget. A single existing object can be up to 64 MiB. `max_upload_kbps=2000` controls the spacing between cold-pack starts; it is not a socket rate limit. While a call or push-to-talk is busy, no new pack is started, and requests already started run to completion. Wider tiering, continuous budgeted migration and per-chunk rate limiting are left to later versions.

A cold copy must prove it is complete before the hot copy can be deleted. After upload the whole pack is read back, the pack hash is checked, every chunk is decoded and checked again, and only when everything passes is the object-location index written; when it is time to delete the hot copy, the cold pack is downloaded and verified once more. If verification fails, an alert is raised and not a single hot copy for that pack is deleted. Hot copies are kept 2 days by default, configurable; emergency reclaim when space is tight may delete earlier, still only after the cold copy has been verified and an alert raised.

## 4. Self-growth

Always-on operation is about whether she can keep you good company today; self-growth is about whether she will be better tomorrow. At the very top of Yimi's persona sits the most fundamental rule: "You learn, build and use tools on your own; this is what sets you apart from an ordinary program."

### 4.1 Building her own tools

"From now on, tell me as soon as a parcel arrives." Yimi first uses `capability_find` to look for something existing in three places: installed packages, the Hermes skills hub and the official MCP registry. If something fits, she writes only the manifest and receipt wrapper, with adapter code under 200 lines in total. If nothing fits, she starts from the template `yimi-capability-template` and builds a package herself: a manifest skeleton, two receipt helpers in Python and TS, `SKILL.md`, contract tests and `fake/` (Figure 11).

Building happens in a separate workshop. The workshop sits in its own Docker network with a read-only root filesystem, 256 MiB memory, 0.5 CPU and at most 128 processes, and does not mount the data volumes of everyday conversation and memory; it can still read workshop snapshots, configuration and read-only desktop input. A finished package must pass the platform's registration checks, or it cannot go live:

- **Static checks.** Paths must be canonical, and the package may contain only portable files (no smuggled kernel plugin hooks); secret filenames and secret literals are scanned for; the manifest must pass the upstream schema and our extension schema; `mcp.json` may have only one stdio entry, and the command may only be `python3` or `node`; `SKILL.md`, `fake/`, contract tests and `scripts/test.py` are required; adapter modules total at most 200 lines; at most 32 files, each at most 128 KiB, at most 512 KiB in total. **Packages Yimi builds may not declare `spend` or `self_change`**, even hidden in some argument branch; the schema rejects it outright: spending money and changing herself are protected baselines.
- **Effect-honesty check.** In a sandbox, the contract cases run against both the fake and the real implementation. The sandbox runs in an empty network namespace and traces system calls with ptrace and seccomp: if a tool declared read-only writes a file, or any run creates a socket other than a local one, it fails; every result must pass receipt validation as-is.

![Yimi building her own capability](../images/flow-04-self-made-package.svg)

*Figure 11 | Yimi building her own capability: from a wish to going live and rolling back.*

A candidate that passes is identified by its content digest. On publishing, the system first checks that the live version has not been changed by someone else, then preloads the new version, activates it and tells Hermes to refresh its tool list, with no Hermes restart; if activation fails, it tries to restore the previous selection. Publishing self-built packages does not go through staging and adds no go-live confirmation: external sends in the package still need first-time confirmation at runtime, and self-built packages cannot declare payment capability.

After going live, the platform watches every package Yimi built during each maintenance cycle. If a health check fails, or the new version's "failed + unknown" rate is clearly higher than the previous version's, it rolls back automatically. "Clearly" is judged with a 95% Wilson interval, with at least 20 finished results on each side. Let a version have $b$ failed or unknown results out of $n$, $\hat p=b/n$, $z=1.96$:

$$
p_{\pm}=\frac{\hat p+\frac{z^2}{2n}\pm z\sqrt{\frac{\hat p(1-\hat p)}{n}+\frac{z^2}{4n^2}}}{1+\frac{z^2}{n}},\qquad
\text{rollback} \iff p_-^{\text{new}} > p_+^{\text{old}}
$$

For example, if the old version failed 2 of 40 times, its interval is about $[0.014, 0.165]$. If the new version failed 6 of 20 times (30%), its interval is about $[0.145, 0.519]$; the lower bound does not exceed 0.165, so there is no rollback yet, and the system waits for more samples. If the new version failed 12 of 30 times, its interval is about $[0.246, 0.577]$; the lower bound exceeds the old version's upper bound, and it rolls back automatically. With few samples and lots of noise it stays put; it acts only on a real regression.

If the user says he does not want this version, Yimi calls `skills_hub(action="revert")` to go back to the previous one; if this is the first version, the package is removed.

Once the tool is built, "tell me when a parcel arrives" still needs ongoing watching. Yimi saves a watch definition with a native scheduled job, and on each run `paios_watch_check` notifies once only when the specified transition happens:

$$
\text{notify} \iff s_{\text{last}}\in\{\varnothing,\ s_{\text{from}}\}\ \land\ s_{\text{now}}=s_{\text{to}}
$$

The notification is first written into state as a pending record and cleared only when the service returns `delivered`; after an interruption it is resent with the same notification ID.

### 4.2 Repairing herself

When the user finds a bug, he simply tells Yimi. She first works out where the problem lies: her own wording, habits and skills she changes on the spot; product code goes to the build workshop (Figure 12).

![Self-repair and self-evolution of the kernel](../images/flow-05-self-repair.svg)

*Figure 12 | Self-repair and self-evolution of the kernel. Dashed boxes are steps in progress.*

The repair happens in an isolated workshop. The instructions require reproducing the problem first, tracing producers and consumers to the root cause, fixing it at the source with a minimal change, and adding a regression test that fails before the fix and passes after; the first line of the commit message must be a sentence the user can understand, and the go-live notice uses it. The patch may not exceed 1 MiB. When a fix touches a protected baseline (payment, real taps and ride hailing, first-send confirmation, identity, care and guest permissions, secrets and sandbox, remote Mac access, release and rollback), the candidate is held and the user is asked once with a confirmation card: if he agrees it continues, if he refuses it ends truthfully. The persona's "most fundamental rule" is protected too.

Once the patch enters the release pipeline, it passes these gates in order: an immutable image is built; 7 test suites run in an offline container with a read-only root filesystem (gateway, integration, platform data, gateway and integration under Hermes, Hermes, phone executor). Let the set of known failures of the live version be $F_{\text{base}}$ and the candidate's set of failures $F_{\text{cand}}$; the gate is:

$$
F_{\text{cand}}\setminus F_{\text{base}}=\varnothing
$$

A non-zero exit code with no parsable failure names also counts as a failure. When Yimi changes the kernel, she must also first check whether staging and production match (code commit, native code tree, service images, skill directory, package registrations, configuration structure and data snapshot time); if not, she first syncs staging to match production, then runs the regression in staging on the latest snapshot (in progress).

On the production host the candidate is checked again: its base must equal the commit live right now, otherwise it is voided and the fix is redone on the current live version. Then it waits for idle: no calls, no runs or background delegations in progress, no session write leases or session compression locks, no phone tasks in progress, no fault-rule hits in the logs of the last 5 minutes, and no out-of-memory marker on the containers. Only then does it back up the database, stop writes, switch the version pointer, start the new version, and verify that every service is running the accepted image and is healthy. After going live, the user gets a system message whose content is the first line of the fix commit (at most 200 characters), saying what was fixed.

A watchdog independent of Yimi then watches the new version (Figure 13). It records the start of persistent unhealthiness $t_b$ and the restart count $R_W(t)$ within time window $W$. Let the unhealthy threshold be $U$ and the restart limit $L$:

$$
\bigl(t_b\ne\varnothing \land t-t_b\ge U\bigr)\ \lor\ R_W(t)\ge L
$$

When the condition holds, it rolls back, one attempt only: before acting it writes the rollback intent to a state file, and if the process restarts and reads it, it only keeps watching and notifying, without switching versions again; if a third image appears, a newer release has taken over and the watchdog does not overwrite it. $U$, $W$ and $L$ have no built-in defaults and must come from measured switch and health-check durations; the documentation uses $U=W=180$ s and $L=3$ as an example.

![Platform release and rollback](../images/flow-06-release.svg)

*Figure 13 | Platform release and rollback.*

Undo does not rely on a fixed phrase. The user can say it any way, as long as he means he does not want this version. Yimi calls `skills_hub(action="release_rollback")`, the user's own words are queued as the reason, and the production host undoes the latest switch at the next idle moment. It runs only if the version currently running is exactly the one brought up by the latest switch; otherwise it refuses and says why, so that saying it twice does not switch back to the version just undone. Version rollback swaps only programs and configuration; it does not restore the database or undo external actions that already happened. The cleanup command keeps only two versions, the current one and the previous one.

### 4.3 Learning from experience

Suppose a background milk-tea order took a detour: the model went round the app several times before discovering it had to enter a certain entry point first. If this lesson stays only in that one record, she will take the same detour next time.

Learning from experience uses Hermes's native background review (Figure 14). The execution subagent that actually does the work has the skill-writing tool `skill_manage`; once its tool iterations reach the configured threshold (10 rounds in the tests) and the turn ended normally without interruption, it submits a snapshot of the experience to review. The review enters the native idle queue and starts only after every conversation turn in the process has ended and things are quiet, so it does not compete with the user's conversation for resources. Runs by guests and unconfirmed identities are not reviewed. The user can also ask her directly to summarize something, and the main agent dispatches another subagent to do it.

![From experience to practice](../images/rep-13-learning.svg)

*Figure 14 | From one experience to how it is done next time.*

The review writes the experience into a skill, so next time the same kind of task follows it. There is one hard boundary here: workshop tools cannot be changed directly with `skill_manage`; they must go through build, test and promotion, or the package registration flow. A mistake in text affects how something is done next time; a mistake in code may directly carry out a wrong action, so it must be tested first.

Engineering rules are also written as a skill, `engineering-handbook`: build and repair agents read it first when they start, and once the handbook is updated, agents started afterwards read the new content.

## 5. What comes next

Always-on operation and self-growth come down to the same thing: every day she spends with the user leaves something that makes the next day better. A confirmed voice becomes a channel sample, a detour becomes a step in a skill, a complaint becomes a fix that goes live, and a missing capability becomes a new capability package.

Version 0.1.5 provides local-model switching, per-capture-channel voiceprint verification thresholds that never decrease, and a speaking-preferences area, and adds optional meeting-assistant server orchestration and a protocol. Once a local catalog is configured, settings can switch speech recognition, voice activity detection, voiceprint, wake-word and embedding models after a device-signed approval, and show the selected and effective versions, the previous version, progress and errors. The deployer must configure `local_catalog_file` and supply model files, absolute paths and trusted digests; this entry point does not download models. Changing a speech model requires a service restart; changing the voiceprint model also requires re-enrollment and calibration for each capture channel in use. Embedding models need their own runtime environment and take effect only after derived indexes are rebuilt. Face models are listed, but switching them goes through the face-enrollment flow.

**Speaking preferences.** Yimi can choose preset tone, expression and habit preferences in the platform preference area, up to 1,500 characters, and restore the previous version. The platform stores the versions and projects them into a read-only `memories/PERSONALITY.md`; preferences cannot change her identity, locked personality or protected rules.

**Optional meeting assistant (end-to-end work in progress).** This version provides optional meeting-assistant server orchestration and a presentation protocol, covering slide reads, locating text from the discussion, edit previews, first-edit consent and reconciliation of unknown results. Actual Keynote reads and writes require a Mac executor that implements this protocol and returns edit-readback evidence. The included Mac source does not yet implement these tools, so enabling the package alone does not make the assistant usable. Connecting such an executor also requires a configured platform port and internal service credentials, an authorized local file, and the specified Mac and one pair of glasses online. The protocol limits edits to replacing text and appending paragraphs; the default deployment does not enable the package.

Still in progress: removing the residual kernel patch; when Yimi changes her own kernel, aligning staging with production first and then completing a full-system staging regression; and implementing the meeting assistant's Mac executor to complete Keynote reads and writes.

Further out: A2A integration between assistants is still in progress, and the current public version has no complete integration. Capability packages backed by another agent are also a later direction. When that day comes, Yimi can negotiate something directly with someone else's Yimi (another person's agent that comes to her is always treated as a guest first; her going to another person's agent counts as an external send and goes through first-time confirmation), and the two people only need to nod at the end.
