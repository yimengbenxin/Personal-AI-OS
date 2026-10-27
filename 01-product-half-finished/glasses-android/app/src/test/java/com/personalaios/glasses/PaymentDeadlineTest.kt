package com.personalaios.glasses

import android.app.Application
import android.content.Context
import android.os.Looper
import io.livekit.android.room.Room
import io.livekit.android.room.DefaultsManager
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.Track
import kotlinx.coroutines.*
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.startCoroutineUninterceptedOrReturn
import kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.*
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.util.ReflectionHelpers
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class PaymentDeadlineTest {
    private fun notice(id: String = "pay-A", ttl: Long = 100, state: String = "awaiting_owner") = JSONObject()
        .put("operation", "payment_notice").put("notice", JSONObject().put("payment_id", id).put("state", state)
            .put("voice_hint", true).put("expires_in_ms", ttl))

    private class Fixture : AutoCloseable {
        val service = Robolectric.buildService(CompanionService::class.java).get()
        val scope: CoroutineScope = ReflectionHelpers.getField(service, "scope")
        val cards = HudCards("glasses")
        val room = mock(Room::class.java)
        val participant = mock(LocalParticipant::class.java)
        val audioDefaults = AudioTrackPublishDefaults()
        val track = mock(LocalAudioTrack::class.java)
        val live = LiveSession(mock(Context::class.java), scope, {}, {}, { _, _ -> })
        init {
            `when`(room.state).thenReturn(Room.State.CONNECTED)
            `when`(room.localParticipant).thenReturn(participant)
            `when`(participant.audioTrackPublishDefaults).thenReturn(audioDefaults)
            ReflectionHelpers.setField(participant, "defaultsManager", mock(DefaultsManager::class.java))
            `when`(participant.getTrackPublication(Track.Source.MICROPHONE)).thenReturn(mock(LocalTrackPublication::class.java))
            ReflectionHelpers.setField(live, "room", room)
            ReflectionHelpers.setField(live, "localMicrophone", track)
            ReflectionHelpers.setField(service, "session", live)
            ReflectionHelpers.setField(service, "inbox", cards)
            CompanionService.state.value = HudState(paired = true, listening = true)
        }
        fun snapshot() { ReflectionHelpers.callInstanceMethod<Unit>(service, "snapshot") }
        suspend fun applyMicrophone() = suspendCoroutineUninterceptedOrReturn<Unit> { continuation ->
            val method = CompanionService::class.java.getDeclaredMethod("syncMicrophone", Continuation::class.java)
            method.isAccessible = true
            method.invoke(service, continuation)
        }
        fun elapse(ms: Long) {
            // Production deadlines use System.nanoTime; the Android handler runs on the paused test looper.
            Thread.sleep(ms)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))
        }
        override fun close() { scope.cancel(); CompanionService.state.value = HudState() }
    }

    @Test fun deadlineAloneUnpublishesStopsAndDisposesTheActualMicrophoneTrack() {
        Fixture().use { f ->
            f.cards.accept(notice(ttl = 100))
            f.snapshot()
            assertEquals(Microphone.On, microphone(CompanionService.state.value))
            verify(f.participant, never()).unpublishTrack(f.track, stopOnUnpublish = false)
            f.elapse(150)
            verify(f.participant).unpublishTrack(f.track, stopOnUnpublish = false)
            verify(f.track).stopPrewarm(); verify(f.track).stop(); verify(f.track).dispose()
            assertNull(CompanionService.state.value.payment)
            assertNull(ReflectionHelpers.getField<LocalAudioTrack?>(f.live, "localMicrophone"))
        }
    }

    @Test fun replacingTheGenerationCancelsItsOldDeadlineAndOldNoticeCannotRenewIt() {
        Fixture().use { f ->
            f.cards.accept(notice(ttl = 100)); f.snapshot()
            f.cards.accept(notice("pay-B", ttl = 400)); f.snapshot()
            f.cards.accept(notice("pay-A", ttl = 900)); f.snapshot()
            assertEquals("pay-B", CompanionService.state.value.payment!!.paymentId)
            f.elapse(150)
            verify(f.participant, never()).unpublishTrack(f.track, stopOnUnpublish = false)
            assertEquals("pay-B", CompanionService.state.value.payment!!.paymentId)
            f.elapse(300)
            verify(f.participant).unpublishTrack(f.track, stopOnUnpublish = false)
        }
    }

    @Test fun stateChangesAndExpiredReplaysCannotExtendTheOriginalCaptureDeadline() {
        val cards = HudCards("glasses")
        cards.accept(notice(ttl = 100), 0)
        cards.accept(notice(ttl = 500, state = "verifying"), 20)
        cards.accept(notice(ttl = 500), 101)
        assertNull(cards.payment(101))
        cards.clearPayment()
        cards.accept(notice(ttl = 500), 102)
        assertNull(cards.payment(102))
        cards.accept(notice("pay-new", ttl = 100), 103)
        assertEquals("pay-new", cards.payment(103)!!.paymentId)
    }

    @Test fun paymentDeadlineDoesNotRemoveAnIndependentlyRequestedMicrophone() {
        Fixture().use { f ->
            CompanionService.state.value = CompanionService.state.value.copy(recording = true)
            f.cards.accept(notice(ttl = 100)); f.snapshot()
            f.elapse(150)
            verify(f.participant, never()).unpublishTrack(f.track, stopOnUnpublish = false)
            assertEquals(Microphone.On, microphone(CompanionService.state.value))
        }
    }

    @Test fun voiceCaptureRequiresAFiniteLocalDeadline() {
        val cards = HudCards("glasses")
        val packet = notice().apply { getJSONObject("notice").remove("expires_in_ms") }
        cards.accept(packet, 0)
        assertEquals(Microphone.Off, microphone(HudState(payment = cards.payment(0)), 0))
    }

    @Test fun lateResultStillDisplaysWithoutReopeningRetiredCapture() {
        val cards = HudCards("glasses")
        cards.accept(notice(state = "outcome_unknown"), 0)
        cards.accept(notice(state = "paid"), 10)
        assertEquals("paid", cards.payment(10)!!.state)
        cards.accept(notice(state = "paid"), 1000)
        assertNull(cards.payment(3010))
        cards.accept(notice(), 1001)
        assertEquals("paid", cards.payment(1001)!!.state)
        cards.accept(notice("pay-B"), 1002)
        cards.accept(notice(state = "paid"), 1003)
        assertEquals("pay-B", cards.payment(1003)!!.paymentId)
    }

    @Test fun deadlineCancelsAPendingPublicationAndRemovesCaptureWithoutCancellingItsCaller() {
        Fixture().use { f ->
            val entered = CompletableDeferred<Unit>()
            var cancelled = false
            val publish: suspend () -> Boolean = {
                entered.complete(Unit)
                try { awaitCancellation() } finally { cancelled = true }
            }
            `when`(f.participant.getTrackPublication(Track.Source.MICROPHONE)).thenReturn(null)
            runBlocking {
                doAnswer { call ->
                    @Suppress("UNCHECKED_CAST")
                    val continuation = call.rawArguments.last() as Continuation<Boolean>
                    publish.startCoroutineUninterceptedOrReturn(continuation)
                }.`when`(f.participant).publishAudioTrack(f.track, AudioTrackPublishOptions(null, f.audioDefaults), null)
            }
            f.cards.accept(notice(ttl = 1000)); f.snapshot()
            val applying = f.scope.launch { f.applyMicrophone() }
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(entered.isCompleted)
            f.elapse(1050)
            assertTrue(cancelled)
            verify(f.participant).unpublishTrack(f.track, stopOnUnpublish = false)
            verify(f.track).dispose()
            assertTrue(applying.isCompleted); assertFalse(applying.isCancelled)
            verify(f.room, never()).disconnect()
        }
    }
}
