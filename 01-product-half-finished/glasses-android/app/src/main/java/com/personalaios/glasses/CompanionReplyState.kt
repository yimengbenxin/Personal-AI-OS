package com.personalaios.glasses

import org.json.JSONObject

data class CompanionReplyLine(val text: String, val cards: List<HudCard>, val speaking: Boolean,
    val alpha: Float = 1f, val nextUpdateMs: Long = 1000L, val expiresAt: Long = Long.MAX_VALUE)

/** A notification selects a presentation only. FormalReplies still owns every delivery receipt. */
class CompanionReplyState {
    private class Entry(val at: Long) {
        var epoch = 0L; var voice = true; var speaking = false; var finalVoice = false
        var finished: Long? = null; var retired = false
        val cards = linkedMapOf<String, HudCard>(); val rendered = mutableSetOf<String>()
    }
    private val entries = linkedMapOf<String, Entry>()
    fun notice(message: JSONObject, now: Long): Boolean {
        val text = message.getString("text")
        if (message.has("private") || message.has("reminder_id") || text.codePointCount(0, text.length) > 48) return false
        val id = message.getString("processed_event_id")
        if (id !in entries) {
            entries.values.forEach { it.retired = true }
            entries[id] = Entry(now)
            while (entries.size > 32) entries.remove(entries.keys.first())
        }
        return true
    }
    fun header(message: JSONObject, now: Long) {
        val e = entries[message.getString("processed_event_id")] ?: return
        val epoch = message.getLong("reply_epoch")
        if (epoch < e.epoch) return
        if (epoch > e.epoch) { e.cards.clear(); e.rendered.clear(); e.epoch = epoch; e.finished = null; e.speaking = false; e.finalVoice = false }
        if (message.getString("reply_phase") != "sealed") { e.retired = true; return }
        e.voice = message.getString("voice_status") in setOf("pending", "ready", "completed")
        settle(e, now)
    }
    fun card(card: HudCard) {
        val ack = card.ack ?: return
        val e = entries[ack.getString("processed_event_id")] ?: return
        if (ack.getJSONObject("ack").getLong("reply_epoch") != e.epoch || e.retired) return
        e.cards[card.id] = card
    }
    fun rendered(command: JSONObject, now: Long) {
        val e = entries[command.getString("processed_event_id")] ?: return
        if (command.getJSONObject("ack").getLong("reply_epoch") != e.epoch) return
        e.cards.values.filter { canonicalJson(it.ack) == canonicalJson(command) }.forEach { e.rendered.add(it.id) }
        settle(e, now)
    }
    fun playback(id: String, epoch: Long, playing: Boolean, final: Boolean, now: Long) {
        val e = entries[id] ?: return
        if (epoch != e.epoch || e.retired) return
        e.speaking = playing
        if (!playing && final) e.finalVoice = true
        settle(e, now)
    }
    private fun settle(e: Entry, now: Long) {
        if (e.cards.isNotEmpty() && e.cards.keys.all { it in e.rendered } && (!e.voice || e.finalVoice))
            e.finished = e.finished ?: now
    }
    fun owns(card: HudCard) = card.ack?.optString("processed_event_id") in entries
    fun snapshot(now: Long): CompanionReplyLine? {
        val e = entries.values.lastOrNull() ?: return null
        val remaining = e.finished?.let { 3500 - (now - it) }
        if (e.retired || now - e.at >= 60000 || remaining != null && remaining <= 0) { e.retired = true; return null }
        val cards = e.cards.values.sortedBy { it.ack!!.getJSONObject("ack").getLong("highest_contiguous_seq") }
        val text = cards.flatMap { it.lines }.joinToString("")
        if (text.isBlank() || text.codePointCount(0, text.length) > 48) return null
        return CompanionReplyLine(text, cards, e.speaking, remaining?.let { (it / 500f).coerceIn(0f, 1f) } ?: 1f,
            remaining?.let { if (it > 500) it - 500 else 50L } ?: 1000L, minOf(e.at + 60000, e.finished?.plus(3500) ?: Long.MAX_VALUE))
    }
    fun clear() = entries.clear()
}

fun companionReplyLine(state: HudState, screen: HudScreen, now: Long, activityVisible: Boolean = false): CompanionReplyLine? {
    val base = (screen as? HudScreen.Menu)?.under ?: screen
    if (!state.paired || !state.ambient || state.callId != null || state.capture.worn != true || state.capture.privatePaused ||
        state.paymentLock.locked || now < state.paymentLock.bannerUntil || state.payment != null ||
        state.ride != null || state.nav != null || base != HudScreen.Idle) return null
    val line = state.companionReply ?: return null
    val remaining = line.expiresAt - now
    if (remaining <= 0) return if (activityVisible) null else CompanionReplyLine("", emptyList(), false, nextUpdateMs = 60000L)
    return line.copy(alpha = (remaining / 500f).coerceIn(0f, 1f), nextUpdateMs = if (remaining > 500) minOf(1000L, remaining - 500) else 50L)
}
