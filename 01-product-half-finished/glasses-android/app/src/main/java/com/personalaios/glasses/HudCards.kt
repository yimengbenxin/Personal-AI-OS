package com.personalaios.glasses

import org.json.JSONObject
import android.os.Handler
import android.os.Looper

data class HudAction(val id: String, val label: String, val command: JSONObject, val lines: List<String>? = null)
data class HudCard(val id: String, val title: String, val lines: List<String>, val priority: Int,
    val expiresAt: Long, val progress: String? = null,
    val actions: List<HudAction> = emptyList(), val ack: JSONObject? = null, val startedAt: Long = 0,
    val companion: Boolean = false)
/** A call_transcript line (mine = the owner's); the same turn's partial updates replace it in place. */
data class HudCaption(val id: String, val role: String, val turn: Long, val text: String, val at: Long) {
    val mine get() = role == "user"
}
data class HudState(val status: String = "配置连接", val cards: List<HudCard> = emptyList(),
    val paired: Boolean = false, val listening: Boolean = false, val callId: String? = null,
    val camera: Boolean = false, val busy: Boolean = false, val gateway: String = "", val capture: CaptureState = CaptureState(), val micMuted: Boolean = false,
    val ride: JSONObject? = null, val nav: JSONObject? = null, val moveAt: Long = 0, val rideAt: Long = moveAt, val say: String? = null, val sayAt: Long = 0,
    val navigationRoute: NavigationRoute? = null, val navigationFix: NavigationFix? = null,
    val routeOverviewUntil: Long = 0, val navigationMoving: Boolean = false,
    val summary: JSONObject? = null, val summaryAt: Long = 0, val captions: List<HudCaption> = emptyList(),
    val payment: PaymentNotice? = null, val paymentLock: GlassesLockState = GlassesLockState(),
    val voiceEnrollment: VoiceEnrollmentState = VoiceEnrollmentState(), val voiceSupplement: VoiceSupplementState = VoiceSupplementState(), val ambient: Boolean = false,
    val localWake: LocalWakeState = LocalWakeState.Off, val localWakeEnabled: Boolean = false, val phoneAudio: Boolean = false,
    val callPcmPublished: Boolean = false, val callClosing: Boolean = false, val callPlayback: Boolean = false, val callEnded: Boolean = false,
    val foregroundCalls: Set<String> = emptySet(), val backgroundWorkCount: Int? = null,
    val avatarPhase: String = "Off", val recording: Boolean = false,
    val conversation: CallConversation? = null, val conversationPending: CallModeRequest? = null, val conversationError: String? = null,
    val avatar: AvatarPortrait? = null, val ambientConfirmation: Boolean = false,
    val activities: List<ActivityCard> = emptyList(), val legacyProgressCovered: Boolean = false,
    val microphoneApplied: Microphone? = null, val ambientRequestedAt: Long = 0L, val ambientError: String? = null,
    val companionReply: CompanionReplyLine? = null)

class HudCards(private val deviceId: String, val replies: FormalReplies = FormalReplies(deviceId),
    private val monotonic: () -> Long = android.os.SystemClock::elapsedRealtime,
    private val wireNow: () -> Long = ServerClock.shared::nowMillis,
    private val activityChanged: () -> Unit = {}) {
    private val activities = linkedMapOf<String, ActivityCard>()
    private data class RetiredActivity(val revision: Long, val processed: String, val until: Long)
    private val retiredActivityRevisions = linkedMapOf<String, RetiredActivity>()
    private var retiredRevisionFloor = -1L
    private val activityHandler by lazy { Handler(Looper.getMainLooper()) }
    private var activityExpiry: Runnable? = null
    // At most 64 terminal payloads and 256 identities; retired identities live ten minutes.
    private fun reclaimActivities() {
        val now = monotonic()
        val terminal = activities.values.filter { !it.ongoing }
        terminal.forEachIndexed { index, card ->
            if (card.alpha(now) == 0f || index < terminal.size - 64) {
                retiredActivityRevisions[card.id] = RetiredActivity(card.revision, card.processedEventId, now + 600_000)
                activities.remove(card.id)
            }
        }
        val retired = retiredActivityRevisions.entries.iterator()
        while (retired.hasNext()) {
            val identity = retired.next().value
            if (identity.until <= now || retiredActivityRevisions.size > 256) {
                retiredRevisionFloor = maxOf(retiredRevisionFloor, identity.revision)
                retired.remove()
                if (activities.values.none { it.processedEventId == identity.processed } &&
                    retiredActivityRevisions.values.none { it.processed == identity.processed })
                    cards.entries.removeAll { it.value.ack?.optString("processed_event_id") == identity.processed }
            }
        }
        activityExpiry?.let(activityHandler::removeCallbacks)
        activityExpiry = (activities.values.filter { !it.ongoing }.map { it.receivedAt + 3500 } +
            retiredActivityRevisions.values.map { it.until }).minOrNull()?.let { until ->
            Runnable { activityExpiry = null; reclaimActivities(); activityChanged() }.also {
                activityHandler.postDelayed(it, (until - now).coerceAtLeast(0))
            }
        }
    }
    fun activities(): List<ActivityCard> {
        reclaimActivities()
        return activities.values.toList()
    }
    fun legacyProgressCovered(card: HudCard? = cards.values.lastOrNull { it.progress != null }): Boolean =
        card?.ack?.optString("processed_event_id")?.let { processed ->
            activities.values.any { it.processedEventId == processed } || retiredActivityRevisions.values.any { it.processed == processed }
        } ?: false
    private val cards = linkedMapOf<String, HudCard>()
    val companionReply = CompanionReplyState()
    private val captions = linkedMapOf<String, HudCaption>()
    private var payment: PaymentNotice? = null
    private val retiredPayments = mutableSetOf<String>()
    var accepted: JSONObject? = null
        private set
    fun captions() = captions.values.toList()
    fun payment(now: Long = monotonicMillis()) = payment?.takeIf { it.until > now }
    fun clearPayment() { payment?.let { retiredPayments.add(it.paymentId) }; payment = null }

    fun accept(message: JSONObject, now: Long = monotonicMillis(), companionMode: Boolean = false): List<HudCard> {
        snapshot(now)
        accepted = null
        when (message.getString("operation")) {
            "ambient_reply" -> if (companionMode && companionReply.notice(message, now)) {
                replies.notified(message.getString("processed_event_id"))?.let { companionReply.header(it, now) }
                cards.values.forEach(companionReply::card)
            }
            "activity_update" -> {
                activities()
                val next = ActivityCard.from(message, monotonic())
                if (next.revision > (activities[next.id]?.revision ?: retiredActivityRevisions[next.id]?.revision ?: retiredRevisionFloor)) {
                    retiredActivityRevisions.remove(next.id)
                    activities.remove(next.id)
                    activities[next.id] = next
                }
                reclaimActivities()
            }
            "payment_notice" -> {
                val next = PaymentNotice.from(message, now)
                if (next == null) clearPayment()
                else if (next.paymentId !in retiredPayments || next.terminal && (payment == null || next.paymentId == payment?.paymentId)) {
                    val previous = payment
                    if (previous != null && previous.paymentId != next.paymentId) retiredPayments.add(previous.paymentId)
                    payment = if (previous?.paymentId == next.paymentId && (!next.terminal || next.state == previous.state))
                        next.copy(until = minOf(next.until, previous.until)) else next
                    if (next.terminal) retiredPayments.add(next.paymentId)
                }
            }
            "display_card" -> {
                val id = message.getString("card_id")
                val lines = message.getJSONArray("lines").let { v -> (0 until v.length()).map { v.getString(it) } }
                val actions = message.optJSONArray("actions")?.let { v -> (0 until v.length()).map {
                    val action = v.getJSONObject(it); val command = action.getJSONObject("command")
                    val detail = action.optJSONArray("lines")?.let { v -> (0 until v.length()).map { v.getString(it) } }
                    HudAction(action.getString("id"), action.getString("label"), command, detail)
                } }.orEmpty()
                val priority = when (message.getString("priority")) {
                    "normal" -> 1; "high" -> 2; else -> error("Unknown display priority")
                }
                val progress = message.optJSONObject("progress")?.let {
                    val total = it.getInt("total"); require(total > 0) { "Progress total must be positive" }
                    "${it.getInt("current")}/$total"
                }
                val delivery = message.optJSONObject("delivery")
                val title = message.getString("title")
                val caption = if (message.has("caption")) message.getJSONObject("caption").also {
                    require(it.keys().asSequence().toSet() == setOf("role", "turn")) { "Unknown caption fields" }
                    require(it.get("role") in setOf("user", "assistant", "main_agent")) { "Unknown caption role" }
                    val turn = (it.get("turn") as? Number)?.toDouble()
                    require(turn != null && turn.isFinite() && turn in 0.0..9007199254740991.0 && turn % 1.0 == 0.0) { "Caption turn must be a safe nonnegative integer" }
                } else null
                if (delivery == null && caption != null) {
                    captions[id] = HudCaption(id, caption.getString("role"), caption.getLong("turn"), lines.joinToString(" "), now)
                    while (captions.size > 8) captions.remove(captions.keys.first())
                    return snapshot(now)
                }
                val update = if (delivery != null) replies.accept(message, wireNow()).lastOrNull() ?: return snapshot(now) else null
                val card = HudCard(id, title, lines, priority,
                    now + message.getLong("lifetime_ms"), progress = progress, actions = actions, ack = update?.cardAck,
                    startedAt = cards[id]?.startedAt ?: now)
                accepted = update?.ack
                put(card)
                companionReply.card(card)
            }
            "accepted", "result_header", "ack_receipt" -> {
                replies.accept(message, wireNow()).forEach { update ->
                    if (update.reset) cards.values.filter { it.ack?.optString("processed_event_id") == update.id }
                        .forEach { cards.remove(it.id) }
                }
                if (message.getString("operation") == "result_header") companionReply.header(message, now)
            }
        }
        return snapshot(now)
    }
    fun callFailure(text: String, now: Long = monotonicMillis()): List<HudCard> {
        put(HudCard("call-failure", "", listOf(text), 2, now + 5000, startedAt = now))
        return snapshot(now)
    }
    fun notice(now: Long = monotonicMillis(), text: String = "这次请求未完成，请再试一次", priority: Int = 1): List<HudCard> {
        put(HudCard("request-notice", "", listOf(text), priority, now + 5000, startedAt = now))
        return snapshot(now)
    }
    fun snapshot(now: Long = monotonicMillis()): List<HudCard> {
        cards.values.filter { it.expiresAt <= now }.forEach {
            cards.remove(it.id)
        }
        return cards.values.map { it.copy(companion = companionReply.owns(it)) }
    }
    // Arrival order is stable; the last card is the newest presentation.
    private fun put(card: HudCard) {
        cards.remove(card.id)
        cards[card.id] = card
        while (cards.size > 32) cards.remove(cards.keys.first())
    }
    fun action(cardId: String, actionId: String, now: Long = monotonicMillis()): JSONObject? =
        cards[cardId]?.takeIf { it.expiresAt > now }?.actions?.firstOrNull { it.id == actionId }?.command
    fun consume(id: String) { cards.remove(id) }
    fun clearInteractions() { cards.values.filter { it.actions.isNotEmpty() }.forEach { cards.remove(it.id) } }
    fun clearActivities() { activityExpiry?.let(activityHandler::removeCallbacks); activityExpiry = null
        activities.clear(); retiredActivityRevisions.clear(); retiredRevisionFloor = -1
    }
    fun clear() { clearActivities()
        cards.clear(); captions.clear(); replies.clear(); companionReply.clear(); payment = null; retiredPayments.clear(); accepted = null }
}
