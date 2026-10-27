package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PaymentHudTest {
    private fun examples() = JSONObject(javaClass.getResource("/payment-wire-examples.json")!!.readText())
    private fun notice(state: String = "awaiting_owner", reason: String? = null, voice: Boolean = false) = JSONObject()
        .put("operation", "payment_notice").put("notice", JSONObject().put("payment_id", "pay-00000000-0000-4000-8000-000000000001")
            .put("state", state).put("amount_fen", 1660).put("payee", "一点点").put("line", "香柠养乐多")
            .put("voice_hint", voice).put("reason", reason).put("expires_in_ms", 300000))

    @Test fun A7_consumeAmendmentOneFixtureAndEmitItsGlassesShapes() {
        val fixture = examples(); assertTrue(fixture.get("version") is Int); assertEquals(1, fixture.getInt("version")); assertEquals("paios.payment.wire.v1", fixture.getString("schema"))
        val operations = fixture.getJSONObject("examples")
        operations.getJSONArray("payment_notice").let { a -> for (i in 0 until a.length()) HudCards("glasses").accept(a.getJSONObject(i), 0) }
        operations.getJSONArray("payment_lock_state").let { a -> for (i in 0 until a.length()) {
            val message = a.getJSONObject(i); val lease = UnlockLease()
            lease.connection(true); lease.wear(true); lease.accept(message, 0)
            val enrol = VoiceEnrollment(); enrol.request(true, false); enrol.grant(message, 0)
        } }
        operations.getJSONArray("payment_receipt").let { a -> for (i in 0 until a.length()) {
            val message = a.getJSONObject(i); UnlockLease().receipt(message); VoiceEnrollment().accept(message, 0)
        } }
        val lease = UnlockLease { "ctl-1" }; lease.connection(true); lease.wear(true)
        val request = lease.accept(JSONObject().put("lock_enabled", true).put("locked", true).put("wear_poll_ms", 2000), 0)!!
        assertEquals(lease.lockCycle, request.getLong("lock_cycle"))
        val expected = JSONObject(operations.getJSONArray("glasses_unlock_request").getJSONObject(0).toString()).put("lock_cycle", lease.lockCycle)
        assertEquals(canonicalJson(expected), canonicalJson(request))
        assertEquals(canonicalJson(operations.getJSONArray("glasses_lock").getJSONObject(0)), canonicalJson(lease.screen(false)!!))
        val enrol = VoiceEnrollment { "ctl-1" }
        assertEquals(canonicalJson(operations.getJSONArray("voiceprint_enrol_request").getJSONObject(0)), canonicalJson(enrol.request(true, false).single()))
    }

    @Test fun wearStateUsesFormalContractCycle() {
        val contract = JSONObject(javaClass.getResource("/formal-message.v1.json")!!.readText())
        val definition = contract.getJSONObject("inputs").getJSONObject("wear_state").getJSONObject("definition")
        assertEquals("#/${'$'}defs/wear_state_command", definition.getString("${'$'}ref"))
        val command = contract.getJSONObject("${'$'}defs").getJSONObject("wear_state_command")
        assertEquals("integer", command.getJSONObject("properties").getJSONObject("lock_cycle").getString("type"))
        val formal = JSONObject(javaClass.getResource("/formal-wire-examples.json")!!.readText())
        val presence = UnlockLease { "ctl-1" }; presence.connection(true); presence.wear(true)
        assertEquals(canonicalJson(formal.getJSONArray("wear_state").getJSONObject(0)), canonicalJson(presence.wearMessage(true)))
        presence.wear(false)
        assertEquals(canonicalJson(formal.getJSONArray("wear_state").getJSONObject(1)), canonicalJson(presence.wearMessage(false)))
    }

    @Test fun I4_noticeReducerEmitsNoPhysicalGestureActionForEveryPaymentState() {
        for (state in PaymentNotice.states) {
            val cards = HudCards("glasses")
            cards.accept(notice(state), 100)
            val payment = cards.payment(101)!!
            assertTrue(payment.title.isNotBlank()); assertEquals("一点点 ¥16.6", payment.amountLine)
            val hud = HudState(paired = true, payment = payment)
            assertEquals(HudScreen.Payment, reconcileHud(HudScreen.Idle, hud))
            for (gesture in HudGesture.values().filter { it != HudGesture.Pay && it != HudGesture.Resume }) {
                val reduced = reduceHud(HudScreen.Payment, gesture, hud, 101)
                assertNull("$state $gesture", reduced.action)
                assertNull(reduced.cardId); assertNull(reduced.actionId)
            }
        }
    }

    @Test fun voiceHintAndEveryReasonRenderTheSuppliedProjection() {
        val cards = HudCards("glasses")
        cards.accept(notice(voice = true), 0); assertEquals("说「付吧」付款", cards.payment(0)!!.hint)
        cards.accept(notice(), 1); assertEquals("请在手机上点「付款」", cards.payment(1)!!.hint)
        val reasons = listOf("INITIATING_NOT_VOICE", "INITIATING_NOT_OWNER_VERIFIED", "DIFFERENT_TERMINAL", "TERMINAL_LOCKED", "REQUEST_STALE",
            "OVER_AUTO_LIMIT", "OVER_AUTO_DAY_LIMIT", "OVER_VOICE_LIMIT", "OVER_BUDGET", "NEW_PAYEE", "PAYEE_UNREADABLE", "SAME_PAYEE_RECENT",
            "AUTO_PAUSED", "VOICE_NOT_RECOGNIZED", "VOICE_INSUFFICIENT", "VOICE_ATTEMPTS_EXHAUSTED", "VOICE_UNAVAILABLE", "AMOUNT_CHANGED", "AUTO_INTERRUPTED")
        for (reason in reasons) {
            val packet = if (reason == "TERMINAL_LOCKED") examples().getJSONObject("examples").getJSONArray("payment_notice").getJSONObject(2)
                else notice(reason = reason)
            cards.accept(packet, 2)
            assertFalse(PaymentNotice.reasonLine(reason).isNullOrBlank())
            assertEquals(PaymentNotice.reasonLine(reason), cards.payment(2)!!.hint)
        }
        for (reason in listOf("VOICE_DISABLED", "AUTO_DISABLED", "LOCKS_NOT_ENABLED")) {
            cards.accept(notice(reason = reason), 2); assertEquals("请在手机上点「付款」", cards.payment(2)!!.hint)
        }
        cards.accept(notice(reason = "INITIATING_NOT_VOICE"), 3)
        assertFalse(cards.payment(3)!!.hint!!.contains("说「付吧」付款"))
        cards.accept(notice(reason = "NEW_PAYEE"), 4); assertTrue(cards.payment(4)!!.hint!!.contains("第一次"))
    }

    @Test fun lockMasksPrivateVisualsAndRetainsCallAndListeningStateFlags() {
        val cards = HudCards("glasses"); cards.accept(notice(voice = true), 0)
        val private = HudState(paired = true, listening = true, callId = "call", payment = cards.payment(0),
            paymentLock = GlassesLockState(true, true), summary = JSONObject().put("operation", "ride_summary").put("distance_m", 1000),
            cards = listOf(HudCard("chat", "secret", listOf("secret"), 1, Long.MAX_VALUE)),
            captions = listOf(HudCaption("caption", "user", 1, "secret", 0)))
        val visible = visibleHud(private, 0)
        assertNull(visible.payment); assertSame(private.summary, visible.summary); assertTrue(visible.cards.isEmpty()); assertTrue(visible.captions.isEmpty())
        assertTrue(visible.listening); assertEquals("call", visible.callId)
        assertEquals(HudScreen.Locked, reconcileHud(HudScreen.Settings(HudScreen.Idle), visible))
        assertEquals(HudScreen.Locked, reconcileHud(HudScreen.VoiceEnrolment(HudScreen.Idle), visible))
        assertEquals("STOP", reduceHud(HudScreen.Locked, HudGesture.DoubleClick, visible, 0).action)
        assertEquals("UNLOCK", reduceHud(HudScreen.Locked, HudGesture.Click, visible, 0).action)
        val redacted = examples().getJSONObject("examples").getJSONArray("payment_notice").getJSONObject(2)
        cards.accept(redacted, 0); val band = cards.payment(0)!!
        assertFalse(band.voiceHint); assertTrue(band.amountLine.isEmpty()); assertNull(band.line)
        assertFalse(band.toString().contains("nonce")); assertFalse(band.toString().contains("grant-"))
    }

    @Test fun A7_snapshotReplacementExpiryAndLabelsFollowTheReportedState() {
        val cards = HudCards("glasses"); cards.accept(notice(), 0)
        cards.accept(notice().apply { getJSONObject("notice").put("payment_id", "pay-new") }, 1)
        assertEquals("pay-new", cards.payment(1)!!.paymentId)
        fun current(state: String) = notice(state).apply { getJSONObject("notice").put("payment_id", "pay-new") }
        cards.accept(current("verifying"), 2); assertTrue(cards.payment(2)!!.title.contains("核对中"))
        for (state in listOf("granted", "paying")) {
            cards.accept(current(state), 3); assertEquals("付款中", cards.payment(3)!!.title)
        }
        cards.accept(current("paid"), 4); assertEquals("已付款", cards.payment(4)!!.title)
        cards.accept(current("paid"), 2500); assertNull(cards.payment(3004))
        for (state in listOf("failed", "outcome_unknown")) {
            cards.accept(notice(state).apply { getJSONObject("notice").put("payment_id", "pay-$state").put("expires_in_ms", 0) }, 5)
            assertNotNull(cards.payment(999999)); assertNull(cards.payment(5)!!.hint?.takeIf { it == "说「付吧」付款" })
        }
        cards.accept(JSONObject().put("operation", "payment_notice").put("notice", JSONObject.NULL), 6); assertNull(cards.payment(6))
        cards.accept(notice().apply { getJSONObject("notice").put("payment_id", "pay-last") }, 7)
        assertNotNull(cards.payment(7)); assertNull(cards.payment(300007))
    }

    @Test fun malformedNoticeCannotReplaceTheLastValidSnapshot() {
        val cards = HudCards("glasses"); cards.accept(notice(), 0)
        for ((field, value) in listOf("amount_fen" to "1660", "amount_fen" to 1660.5, "amount_fen" to 0, "state" to "invented", "expires_in_ms" to -1))
            assertThrows(IllegalArgumentException::class.java) { cards.accept(notice().apply { getJSONObject("notice").put(field, value) }, 1) }
        assertEquals("一点点 ¥16.6", cards.payment(1)!!.amountLine)
        assertThrows(IllegalArgumentException::class.java) { cards.accept(notice(reason = "TERMINAL_LOCKED"), 1) }
        assertThrows(IllegalArgumentException::class.java) { cards.accept(JSONObject().put("operation", "payment_notice"), 1) }
    }
}
