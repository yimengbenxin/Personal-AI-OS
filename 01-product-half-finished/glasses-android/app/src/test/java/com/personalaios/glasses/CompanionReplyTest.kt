package com.personalaios.glasses

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE, qualifiers = "xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CompanionReplyTest {
    private val inbox = HudCards("glasses", monotonic = { 1000L }, wireNow = { 1000L })
    private fun packet(op: String) = JSONObject().put("operation", op).put("session_id", "session").put("processed_event_id", "processed")
    private fun notice() = packet("ambient_reply").put("heard", "").put("text", "三处意见都记下了。改法在你电脑上，点确认我就改。")
    private fun header(voice: Boolean = true) = packet("result_header").apply {
        put("event_id", "event"); put("run_id", "run"); put("consumed_revision", 1); put("result_revision", 1)
        put("reply_id", "reply"); put("reply_epoch", 1); put("reply_phase", "sealed"); put("reply_mode", "voice")
        put("run_status", "completed"); put("reply_status", "complete"); put("result_status", "completed")
        put("delivery_status", "pending"); put("output_plan", JSONArray().put(JSONObject().put("target_device_id", "glasses")
            .put("device_type", "glasses").put("output_modes", JSONArray().put("text").put("voice")).put("route_version", "route")))
        put("text_replay", "sealed"); put("text_chunk_count", 1); put("rendered_text_through_seq", 0); put("pending_text_chunk_count", 1)
        put("pending_voice_chunk_count", if (voice) 1 else 0); put("voice_transport", if (voice) "livekit_byte_stream" else "not_supported")
        put("voice_status", if (voice) "pending" else "not_requested"); put("receipt_status", "pending")
        put("voice_error", JSONObject.NULL); put("receipt_error", JSONObject.NULL); put("receipt_sources", JSONArray()); put("receipt_refs", JSONArray())
    }
    private fun card() = packet("display_card").put("card_id", "page-1").put("title", "依米")
        .put("lines", JSONArray().put(notice().getString("text"))).put("priority", "normal").put("lifetime_ms", 120000)
        .put("delivery", JSONObject().put("processed_event_id", "processed").put("output_id", "output:one").put("reply_id", "reply")
            .put("target_device_id", "glasses").put("route_version", "route").put("reply_epoch", 1).put("seq", 1).put("final", true))
    private fun ready(voice: Boolean = true) {
        inbox.accept(notice(), 1000, companionMode = true); inbox.accept(header(voice), 1000); inbox.accept(card(), 1000)
    }
    @Test fun noticeOnlyRequestsExistingResultRecoveryAndNeverAcknowledgesText() {
        inbox.accept(notice(), 1000, companionMode = true)
        assertNull(inbox.companionReply.snapshot(1000)); assertNull(inbox.accepted)
        assertEquals("result", inbox.replies.recoveryRequests(1000).single().getString("operation"))
        assertTrue(inbox.replies.pendingReceipts("processed").isEmpty())
        inbox.accept(header(), 1001); inbox.accept(card(), 1002)
        assertEquals(notice().getString("text"), inbox.companionReply.snapshot(1002)!!.text)
        assertFalse(inbox.companionReply.snapshot(1002)!!.speaking)
    }
    @Test fun actualPlaybackDrivesRingAndThreeSecondRetirementWithoutInventingPlayed() {
        ready(); val ack = inbox.snapshot(1000).single().ack!!
        inbox.companionReply.rendered(ack, 1200)
        assertNotNull(inbox.companionReply.snapshot(10000))
        inbox.companionReply.playback("processed", 1, true, false, 10000)
        assertTrue(inbox.companionReply.snapshot(10000)!!.speaking)
        inbox.companionReply.playback("processed", 1, false, true, 11000)
        assertFalse(inbox.companionReply.snapshot(11000)!!.speaking)
        assertNotNull(inbox.companionReply.snapshot(13999)); assertNull(inbox.companionReply.snapshot(14500))
        inbox.accept(notice(), 14501, companionMode = true); inbox.accept(card(), 14502)
        assertNull(inbox.companionReply.snapshot(14502))
        assertTrue(inbox.replies.pendingReceipts("processed").none { it.getJSONObject("ack").getString("status") == "played" })
    }
    @Test fun textOnlyWaitsForRealDrawAndProtectedBandsHavePrecedence() {
        ready(false); assertNotNull(inbox.companionReply.snapshot(10000))
        inbox.companionReply.rendered(inbox.snapshot(1000).single().ack!!, 10000)
        val state = HudState(paired = true, ambient = true, capture = CaptureState(worn = true, privatePaused = false), companionReply = inbox.companionReply.snapshot(10001))
        assertNotNull(companionReplyLine(state, HudScreen.Idle, 10001))
        for (screen in listOf(HudScreen.Payment, HudScreen.Locked, HudScreen.Consent(HudScreen.Idle), HudScreen.Settings(HudScreen.Idle)))
            assertNull(companionReplyLine(state, screen, 10001))
        assertNull(companionReplyLine(state.copy(callId = "call"), HudScreen.Talking, 10001))
        assertNull(companionReplyLine(state.copy(ambient = false), HudScreen.Idle, 10001))
        assertEquals("", companionReplyLine(state, HudScreen.Idle, 13500)!!.text)
        assertNull(companionReplyLine(state, HudScreen.Idle, 13500, activityVisible = true))
        assertNull(inbox.companionReply.snapshot(13500))
    }
    @Test fun shortNoticesOutsideCompanionModeKeepTheExistingCardPresentation() {
        inbox.accept(notice(), 1000); inbox.accept(header(false), 1000); inbox.accept(card(), 1000)
        assertNull(inbox.companionReply.snapshot(1000));assertFalse(inbox.snapshot(1000).single().companion)
        assertEquals(1, visibleHud(HudState(paired = true, cards = inbox.snapshot(1000)), 1000).cards.size)
    }
    @Test fun approvedTransparentBandFitsBothEyesAndSendsAckOnlyForUnclippedText() {
        ready(); val line = inbox.companionReply.snapshot(1000)!!; val context = RuntimeEnvironment.getApplication()
        val pixels = (0..1).map {
            val lens = FrameLayout(context); val view = CompanionReplyHud(context, line, null, null); lens.addView(view)
            lens.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
            lens.layout(0, 0, 640, 480)
            assertTrue(view.textFits()); assertEquals(20f, view.subtitle.textSize, 0f); assertTrue(view.subtitle.typeface.isBold)
            val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888); lens.draw(Canvas(bitmap))
            IntArray(640 * 480).also { bitmap.getPixels(it, 0, 640, 0, 0, 640, 480) }
        }
        assertArrayEquals(pixels[0], pixels[1]); assertTrue(pixels[0].drop(640 * 128).all { it == 0 })
        val hidden = CompanionReplyHud(context, line.copy(text = "长句".repeat(100)), null, null)
        hidden.measure(View.MeasureSpec.makeMeasureSpec(580, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(108, View.MeasureSpec.EXACTLY)); hidden.layout(0, 0, 580, 108)
        assertFalse(hidden.textFits())
    }
}
