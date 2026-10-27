package com.personalaios.glasses

import org.json.JSONObject
import java.util.Locale

/** A read-only optical band. It has no action, nonce, grant or payment command. */
data class PaymentNotice(val paymentId: String, val state: String, val amountFen: Long?, val payee: String?,
    val line: String?, val voiceHint: Boolean, val reason: String?, val until: Long) {
    fun capturesVoice(now: Long) = state == "awaiting_owner" && voiceHint && until != Long.MAX_VALUE && until > now
    val terminal get() = state in setOf("paid", "cancelled", "expired", "superseded", "failed", "outcome_unknown")
    val title get() = when (state) {
        "verifying" -> "付款确认 · 核对中"
        "granted", "paying" -> "付款中"
        "paid" -> "已付款"
        "outcome_unknown" -> "付款结果不明 · 请在手机上核对"
        "cancelled" -> "已取消 · 没有付款"
        "expired" -> "已过期 · 没有付款"
        "superseded" -> "金额已变 · 请看新的付款卡"
        "failed" -> "没有付款 · 请在手机上查看"
        "auto_pending" -> "将自动付款 · 可在手机上取消"
        else -> "付款确认"
    }
    val amountText get() = amountFen?.let { "¥" + String.format(Locale.ROOT, "%.2f", it / 100.0).trimEnd('0').trimEnd('.') }
    val amountLine get() = listOfNotNull(payee, amountText).joinToString(" ")
    val hint get() = when (state) {
        "awaiting_owner" -> if (voiceHint) "说「付吧」付款" else reasonLine(reason) ?: "请在手机上点「付款」"
        "verifying" -> "正在核对：发起这件事的那句 +「付吧」"
        "outcome_unknown" -> "已停止，不会再付一次"
        "failed" -> "请在手机上查看原因"
        else -> null
    }
    companion object {
        val states = setOf("awaiting_owner", "auto_pending", "verifying", "granted", "paying", "paid",
            "outcome_unknown", "cancelled", "expired", "superseded", "failed")
        fun from(message: JSONObject, now: Long): PaymentNotice? {
            require(message.has("notice")) { "Payment notice snapshot is required" }
            if (message.isNull("notice")) return null
            val notice = message.getJSONObject("notice")
            val state = notice.getString("state"); require(state in states)
            val reason = notice.optString("reason").takeIf { it.isNotEmpty() }
            val redacted = reason == "TERMINAL_LOCKED"
            val amount = if (notice.has("amount_fen")) notice.wireLong("amount_fen", 1, 100000000) else null
            val voice = if (redacted) false else notice.get("voice_hint") as Boolean
            val lifetime = if (notice.has("expires_in_ms")) notice.wireLong("expires_in_ms") else null
            if (redacted) require(amount == null && !notice.has("payee") && !notice.has("line") && !notice.has("voice_hint"))
            require(reason == null || redacted || reason in reasons)
            val until = when (state) {
                "paid", "cancelled", "expired", "superseded" -> now + 3000
                "failed", "outcome_unknown" -> Long.MAX_VALUE
                else -> lifetime?.let { now + it } ?: Long.MAX_VALUE
            }
            return PaymentNotice(notice.getString("payment_id"), state, amount,
                notice.optString("payee").takeIf { it.isNotEmpty() }, notice.optString("line").takeIf { it.isNotEmpty() }, voice, reason, until)
        }
        private val reasons = setOf("INITIATING_NOT_VOICE", "INITIATING_NOT_OWNER_VERIFIED", "DIFFERENT_TERMINAL", "REQUEST_STALE",
            "OVER_AUTO_LIMIT", "OVER_AUTO_DAY_LIMIT", "OVER_VOICE_LIMIT", "OVER_BUDGET", "NEW_PAYEE", "PAYEE_UNREADABLE",
            "SAME_PAYEE_RECENT", "AUTO_PAUSED", "VOICE_NOT_RECOGNIZED", "VOICE_INSUFFICIENT", "VOICE_ATTEMPTS_EXHAUSTED",
            "VOICE_UNAVAILABLE", "VOICE_DISABLED", "AUTO_DISABLED", "LOCKS_NOT_ENABLED", "AMOUNT_CHANGED", "AUTO_INTERRUPTED")
        fun reasonLine(reason: String?): String? = when (reason) {
            "INITIATING_NOT_VOICE" -> "打字发起的请求，请在手机上点「付款」"
            "INITIATING_NOT_OWNER_VERIFIED" -> "发起那句没认出是你，请在手机上确认"
            "DIFFERENT_TERMINAL" -> "请在发起请求的同一台设备上说「付吧」"
            "TERMINAL_LOCKED" -> "眼镜还没解锁，不能用声音付款"
            "REQUEST_STALE" -> "请求已超时，请在手机上点「付款」"
            "OVER_AUTO_LIMIT" -> "超过免密上限，请在手机上确认"
            "OVER_AUTO_DAY_LIMIT" -> "超过今天免密上限，请在手机上确认"
            "OVER_VOICE_LIMIT" -> "超过声纹支付上限，请在手机上确认"
            "OVER_BUDGET" -> "超过你说的预算，请在手机上确认"
            "NEW_PAYEE" -> "第一次付给这家，先在手机上点卡片"
            "PAYEE_UNREADABLE" -> "没读到收款方，请在手机上确认"
            "SAME_PAYEE_RECENT" -> "同一家近期第二单，请在手机上确认"
            "AUTO_PAUSED" -> "今天免密已暂停"
            "VOICE_NOT_RECOGNIZED" -> "没听出是你的声音，这次没有付款"
            "VOICE_INSUFFICIENT" -> "声音有点杂，没听清是不是你"
            "VOICE_ATTEMPTS_EXHAUSTED" -> "语音机会用完了，请在手机上确认"
            "VOICE_UNAVAILABLE" -> "声纹暂不可用，请在手机上确认"
            "AMOUNT_CHANGED" -> "收银台金额变了，所以没有付"
            "AUTO_INTERRUPTED" -> "自动付款被打断了，请在手机上确认"
            else -> null
        }
    }
}
