package com.personalaios.glasses

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

/** Reply identity, replay conflicts, and contiguous delivery receipts live here. */
class FormalReplies(private val deviceId: String, saved: JSONObject? = null,
    private val save: (JSONObject) -> Unit = {}) {
    data class TextUpdate(val id: String, val ack: JSONObject?, val reset: Boolean = false, val cardAck: JSONObject? = null)
    private class Reply {
        var header: JSONObject? = null
        var signal = CompletableDeferred<Unit>()
        val chunks = mutableMapOf<Pair<Long, Long>, JSONObject>()
        val voices = sortedMapOf<Long, JSONObject>()
        val receipts = linkedMapOf<Pair<String, Long>, JSONObject>()
        var played = 0L
        var voiceClosed = false
        var through = 0L
        val rendered = mutableSetOf<Long>()
        var discarded = false
        var textOutput: String? = null
        var current = false
        var requested = false
        var paused = false
        var followed = false
        var voiceBase = 0L
        var backoff = 1000L
        var nextRead = 0L
        val confirmedPlayed get() = receipts.keys.filter { it.first == "played" }.minOfOrNull { it.second - 1 } ?: played
    }
    private val replies = linkedMapOf<String, Reply>()
    init {
        if (saved != null) {
            require(saved.getString("device_id") == deviceId) { "Reply recovery belongs to another device" }
            val entries = saved.getJSONArray("replies"); require(entries.length() <= 32)
            for (index in 0 until entries.length()) {
                val entry = entries.getJSONObject(index)
                val reply = Reply().apply {
                    header = entry.optJSONObject("header"); played = entry.getLong("played")
                    through = header?.getLong("rendered_text_through_seq") ?: 0
                    textOutput = entry.optString("text_output").takeIf { it.isNotEmpty() }
                    val seen = entry.getJSONArray("rendered")
                    for (n in 0 until seen.length()) rendered.add(seen.getLong(n))
                    val audio = entry.getJSONArray("voices")
                    for (n in 0 until audio.length()) audio.getJSONObject(n).let { voices[it.getLong("seq")] = it }
                    val pending = entry.getJSONArray("receipts")
                    for (n in 0 until pending.length()) pending.getJSONObject(n).let {
                        val ack = it.getJSONObject("ack"); receipts[ack.getString("status") to ack.getLong("highest_contiguous_seq")] = it
                    }
                }
                replies[entry.getString("processed_event_id")] = reply
            }
        }
    }
    private fun checkpoint() {
        val entries = JSONArray()
        replies.filterValues(::inflight).forEach { (id, reply) -> entries.put(JSONObject()
            .put("processed_event_id", id).put("header", reply.header).put("played", reply.played)
            .put("text_output", reply.textOutput).put("rendered", JSONArray(reply.rendered))
            .put("voices", JSONArray(reply.voices.filterKeys { it <= reply.played }.values))
            .put("receipts", JSONArray(reply.receipts.values))) }
        save(JSONObject().put("device_id", deviceId).put("replies", entries))
    }
    private fun inflight(reply: Reply): Boolean {
        val h = reply.header ?: return true
        if (!reply.current) return true
        return reply.receipts.isNotEmpty() || h.getString("reply_phase") == "sealed" &&
            (h.getString("voice_status") == "pending" || h.getLong("rendered_text_through_seq") < h.getLong("text_chunk_count") ||
                h.getLong("pending_voice_chunk_count") > reply.voices.keys.count { it > reply.voiceBase && it <= reply.confirmedPlayed } ||
                reply.voices.keys.any { it > reply.played })
    }
    private fun reply(id: String): Reply = replies[id] ?: run {
        if (replies.size >= 32) {
            // Prefer confirmed delivery. At saturation the server remains the durable reply owner.
            val retired = replies.entries.firstOrNull { !inflight(it.value) } ?: replies.entries.first().also {
                java.util.logging.Logger.getLogger("Yimi").warning("reply_retired capacity reached; server retains delivery state")
            }
            replies.remove(retired.key)
            retired.value.signal.completeExceptionally(CancellationException("Reply retired"))
        }
        Reply().also { replies[id] = it }
    }
    private fun needsServer(reply: Reply): Boolean {
        if (!inflight(reply) || reply.requested || reply.paused || reply.followed) return false
        val h = reply.header
        if (!reply.current || h == null) return true
        return h.getString("reply_phase") == "sealed" && (h.getString("voice_status") == "pending" ||
            reply.voices.keys.count { it > reply.voiceBase } < h.getLong("pending_voice_chunk_count") ||
            reply.through < h.getLong("text_chunk_count"))
    }
    @Synchronized fun recoveryRequests(now: Long = System.nanoTime() / 1000000): List<JSONObject> = replies.filterValues {
        needsServer(it) && now >= it.nextRead
    }.map { (id, reply) ->
        reply.requested = true
        reply.nextRead = now + reply.backoff; reply.backoff = (reply.backoff * 2).coerceAtMost(30000)
        JSONObject().put("operation", "result").put("processed_event_id", id)
    }
    /** Ambient notices awaken existing result recovery; notification text is never a delivered chunk. */
    @Synchronized fun notified(id: String): JSONObject? {
        val reply = reply(id); checkpoint()
        return reply.header?.let { JSONObject(it.toString()) }
    }
    suspend fun observe(send: suspend (JSONObject) -> Unit, wait: suspend (Long) -> Unit = { delay(it) },
        now: () -> Long = { System.nanoTime() / 1000000 }) {
        try { while (true) {
            recoveryRequests(now()).forEach { send(it) }
            val receipts = synchronized(this) { replies.values.filter { it.current && !it.paused && !it.requested }
                .flatMap { it.receipts.values.toList() } }
            receipts.forEach { send(it) }
            val pause = synchronized(this) {
                if (receipts.isNotEmpty()) 1000L else replies.values.filter(::needsServer)
                    .minOfOrNull { (it.nextRead - now()).coerceAtLeast(1000) } ?: 1000L
            }
            wait(pause)
        } }
        finally { detached() }
    }
    @Synchronized fun detached() {
        replies.entries.removeAll {
            if (inflight(it.value)) false else {
                it.value.signal.completeExceptionally(CancellationException("Reply delivered")); true
            }
        }
        replies.values.forEach {
            it.current = false; it.requested = false; it.paused = false; it.followed = false; it.backoff = 1000; it.nextRead = 0
        }
    }
    @Synchronized fun rejected(packet: JSONObject): Boolean {
        if (packet.getString("request_operation") != "result") return false
        if (packet.get("processed_event_id") == JSONObject.NULL) return false
        val reply = replies[packet.getString("processed_event_id")] ?: return false
        reply.requested = false
        val pending = packet.getString("error_code") in setOf("RUN_NOT_ACCEPTED", "SEALED_TEXT_NOT_AVAILABLE")
        reply.paused = !pending
        if (!pending) reply.current = false
        return pending
    }
    @Synchronized fun accept(packet: JSONObject, now: Long): List<TextUpdate> {
        val id = (packet.optJSONObject("delivery") ?: packet).getString("processed_event_id")
        val reply = reply(id)
        var reset = false
        var cardAck: JSONObject? = null
        when (packet.getString("operation")) {
            "result_header" -> {
                val mode = packet.getString("reply_mode")
                val target = if (mode == "none") null else plan(packet)
                val previous = reply.header
                val epoch = packet.getLong("reply_epoch")
                val replay = packet.getString("text_replay")
                if (previous != null) {
                    if (epoch < previous.getLong("reply_epoch")) return emptyList()
                    if (epoch == previous.getLong("reply_epoch")) {
                        require(packet.get("reply_id") == previous.get("reply_id")) { "Reply identity changed" }
                        if (target != null && previous.getString("reply_mode") != "none") require(target.get("route_version") == plan(previous).get("route_version")) { "Reply route changed" }
                        require(previous.getString("reply_phase") == "sealed" || packet.getString("reply_phase") != "sealed") { "Cancelled epoch cannot resume" }
                    } else {
                        reset = true; reply.voices.clear(); reply.receipts.clear(); reply.played = 0; reply.voiceClosed = false
                        reply.textOutput = null; reply.rendered.clear(); reply.chunks.keys.removeAll { it.first < epoch }
                    }
                }
                val header = JSONObject(packet.toString())
                if (previous != null && !reset) {
                    val rendered = maxOf(header.getLong("rendered_text_through_seq"), previous.getLong("rendered_text_through_seq"))
                    header.put("rendered_text_through_seq", rendered).put("pending_text_chunk_count", header.getLong("text_chunk_count") - rendered)
                }
                reply.voiceClosed = reply.voiceClosed || header.getString("voice_status") == "ready" && header.getLong("pending_voice_chunk_count") == 0L
                if (previous == null || reset || header.getString("voice_status") != previous.getString("voice_status") ||
                    header.getString("reply_phase") != previous.getString("reply_phase") ||
                    listOf("text_chunk_count", "pending_voice_chunk_count", "rendered_text_through_seq").any { header.getLong(it) != previous.getLong(it) }) {
                    reply.backoff = 1000; reply.nextRead = 0
                }
                if (!reply.requested) reply.followed = true
                reply.voiceBase = reply.confirmedPlayed
                reply.header = header
                reply.current = true; reply.requested = false; reply.paused = false
                if (previous == null || reset || reply.discarded) {
                    reply.through = if (replay == "sealed") 0 else header.getLong("rendered_text_through_seq")
                    reply.discarded = false
                }
                if (replay == "pending") reply.through = maxOf(reply.through, header.getLong("rendered_text_through_seq"))
                if (header.getString("reply_phase") != "sealed") {
                    discardText(id); reply.voices.clear(); reply.receipts.clear(); reset = true
                }
                reply.signal.complete(Unit); reply.signal = CompletableDeferred()
            }
            "display_card" -> {
                val chunk = packet.getJSONObject("delivery")
                val key = chunk.getLong("reply_epoch") to chunk.getLong("seq")
                require(chunk.getString("target_device_id") == deviceId)
                val h = reply.header ?: return emptyList()
                if (key.first < h.getLong("reply_epoch")) return emptyList()
                require(bound(chunk, reply))
                if (h.getString("reply_phase") != "sealed") return emptyList()
                reply.chunks[key]?.let { require(canonicalJson(it.get("lines")) == canonicalJson(packet.get("lines")) &&
                    canonicalJson(it.getJSONObject("delivery")) == canonicalJson(chunk)) { "Conflicting text replay" } }
                reply.chunks[key] = JSONObject(packet.toString())
                cardAck = receipt(id, chunk, key.second, "accepted", now)
            }
            "ack_receipt" -> {
                val h = reply.header ?: return emptyList()
                val receipt = packet.getJSONObject("receipt")
                if (receipt.getLong("reply_epoch") < h.getLong("reply_epoch")) return emptyList()
                require(bound(receipt, reply))
                val seq = receipt.getLong("highest_contiguous_seq")
                if (receipt.getString("status") == "played") {
                    val voice = reply.voices[seq] ?: return emptyList()
                    require(receipt.get("output_id") == voice.get("output_id"))
                    reply.played = maxOf(reply.played, seq); reply.receipts.keys.removeAll { it.first == "played" && it.second <= seq }
                } else if (receipt.getString("status") == "rendered") {
                    require(receipt.getString("output_id") == reply.textOutput)
                    val rendered = maxOf(seq, h.getLong("rendered_text_through_seq"))
                    h.put("rendered_text_through_seq", rendered).put("pending_text_chunk_count", h.getLong("text_chunk_count") - rendered)
                    reply.through = maxOf(reply.through, rendered)
                    reply.receipts.keys.removeAll { it.first == "rendered" && it.second <= seq }
                }
            }
        }
        checkpoint()
        val h = reply.header ?: return emptyList()
        val epoch = h.getLong("reply_epoch")
        if (!reply.discarded && h.getString("reply_phase") == "sealed") {
            while (reply.chunks.containsKey(epoch to (reply.through + 1))) reply.through++
        }
        val last = reply.chunks[epoch to reply.through]?.getJSONObject("delivery")
        val ack = if (!reply.discarded && last != null && reply.through > h.getLong("rendered_text_through_seq")) receipt(id, last, reply.through, "accepted", now) else null
        if (last != null) reply.textOutput = last.getString("output_id")
        return listOf(TextUpdate(id, ack, reset, cardAck))
    }
    @Synchronized fun rendered(command: JSONObject, now: Long = ServerClock.shared.nowMillis()): JSONObject? {
        val id = command.getString("processed_event_id"); val reply = replies[id] ?: return null
        val ack = command.getJSONObject("ack"); val h = reply.header ?: return null
        if (!bound(ack, reply) || h.getString("reply_phase") != "sealed") return null
        reply.rendered.add(ack.getLong("highest_contiguous_seq"))
        var through = h.getLong("rendered_text_through_seq")
        while (through + 1 in reply.rendered) through++
        val rendered = if (through > h.getLong("rendered_text_through_seq")) receipt(id, ack, through, "rendered", now) else null
        if (rendered != null) reply.receipts["rendered" to through] = rendered
        checkpoint()
        return rendered
    }
    private fun plan(header: JSONObject): JSONObject = header.getJSONArray("output_plan").let { plans ->
        (0 until plans.length()).map { plans.getJSONObject(it) }.single { it.getString("target_device_id") == deviceId }
    }
    private fun bound(value: JSONObject, reply: Reply): Boolean {
        val h = reply.header!!
        return value.get("reply_id") == h.get("reply_id") && value.get("reply_epoch") == h.get("reply_epoch") &&
            value.getString("target_device_id") == deviceId && value.get("route_version") == plan(h).get("route_version")
    }
    suspend fun awaitHeader(packet: JSONObject) {
        require(packet.getJSONObject("chunk").getString("target_device_id") == deviceId)
        while (true) {
            val signal = synchronized(this) {
                val id = packet.getString("processed_event_id"); val first = id !in replies
                val reply = reply(id)
                if (first || reply.header?.getLong("reply_epoch")?.let { it < packet.getJSONObject("chunk").getLong("reply_epoch") } == true) {
                    reply.current = false; checkpoint()
                }
                if (reply.current && reply.header?.getLong("reply_epoch")?.let { it >= packet.getJSONObject("chunk").getLong("reply_epoch") } == true) null else reply.signal
            } ?: return
            signal.await()
        }
    }
    @Synchronized fun admitVoice(packet: JSONObject): Boolean {
        val reply = replies[packet.getString("processed_event_id")] ?: return false
        val chunk = packet.getJSONObject("chunk"); val seq = chunk.getLong("seq")
        val final = chunk.get("final") as Boolean
        require(chunk.getString("target_device_id") == deviceId)
        if (chunk.getLong("reply_epoch") < reply.header!!.getLong("reply_epoch")) return false
        require(bound(chunk, reply))
        reply.voices[seq]?.let {
            require(sameVoice(it, chunk)) { "Conflicting voice replay" }
            if (final) it.put("final", true)
            return false
        }
        if (!reply.current || reply.voiceClosed || reply.header!!.getString("reply_phase") != "sealed" || seq <= reply.played) return false
        reply.voices[seq] = JSONObject(chunk.toString())
        return true
    }
    @Synchronized fun voiceCurrent(packet: JSONObject): Boolean {
        val reply = replies[packet.getString("processed_event_id")] ?: return false
        val h = reply.header ?: return false
        val chunk = packet.getJSONObject("chunk")
        return reply.current && !reply.voiceClosed && h.getString("reply_phase") == "sealed" && h.getString("reply_mode") in listOf("voice", "text_and_voice") &&
            bound(chunk, reply) && chunk.getLong("seq") > reply.played && reply.voices[chunk.getLong("seq")]?.let { sameVoice(it, chunk) } == true
    }
    private fun sameVoice(first: JSONObject, second: JSONObject): Boolean =
        canonicalJson(JSONObject(first.toString()).apply { remove("final") }) == canonicalJson(JSONObject(second.toString()).apply { remove("final") })
    @Synchronized fun canPlay(packet: JSONObject): Boolean = voiceCurrent(packet) &&
        packet.getJSONObject("chunk").getLong("seq") == replies.getValue(packet.getString("processed_event_id")).played + 1
    @Synchronized fun played(packet: JSONObject, now: Long = ServerClock.shared.nowMillis()): JSONObject {
        check(canPlay(packet)) { "Playback belongs to a retired reply" }
        val reply = replies.getValue(packet.getString("processed_event_id")); val chunk = packet.getJSONObject("chunk")
        val ack = receipt(packet.getString("processed_event_id"), chunk, chunk.getLong("seq"), "played", now)
        reply.played = chunk.getLong("seq"); reply.receipts["played" to reply.played] = ack
        checkpoint()
        return ack
    }
    @Synchronized fun pendingReceipts(id: String): List<JSONObject> = replies[id]?.receipts?.values?.toList().orEmpty()
    @Synchronized fun releaseVoice(packet: JSONObject) {
        val reply = replies[packet.getString("processed_event_id")] ?: return
        val chunk = packet.getJSONObject("chunk"); val seq = chunk.getLong("seq")
        if (seq > reply.played && reply.voices[seq]?.let { sameVoice(it, chunk) } == true) reply.voices.remove(seq)
    }
    private fun receipt(id: String, chunk: JSONObject, seq: Long, status: String, now: Long): JSONObject {
        val ack = JSONObject()
        listOf("output_id", "reply_id", "target_device_id", "route_version", "reply_epoch").forEach { ack.put(it, chunk.get(it)) }
        ack.put("highest_contiguous_seq", seq).put("status", status).put("observed_at", GatewayClient.timestamp(now))
        return JSONObject().put("operation", "ack").put("processed_event_id", id).put("ack", ack)
    }
    @Synchronized fun discardText(id: String) {
        replies[id]?.let { reply -> reply.chunks.keys.removeAll { it.first == reply.header?.getLong("reply_epoch") }; reply.discarded = true }
    }
    @Synchronized fun clear() {
        replies.values.forEach { it.signal.completeExceptionally(CancellationException("Device binding closed")) }; replies.clear(); checkpoint()
    }
}
