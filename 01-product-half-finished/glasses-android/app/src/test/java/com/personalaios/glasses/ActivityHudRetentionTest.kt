package com.personalaios.glasses

import android.app.Application
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class ActivityHudRetentionTest {
    private val fixtures get() = JSONObject(javaClass.getResource("/activity-update.fixtures.json")!!.readText()).getJSONObject("fixtures")
    private fun packet(name: String, id: String, revision: Long) = JSONObject(fixtures.getJSONObject(name).toString()).apply {
        put("processed_event_id", "processed-$id")
        getJSONObject("card").put("id", id).put("revision", revision)
    }
    private fun backing(inbox: HudCards, name: String) = HudCards::class.java.getDeclaredField(name).let {
        it.isAccessible = true; it.get(inbox) as Map<*, *>
    }
    @Test fun silentFinalBatchAndItsTombstonesArePhysicallyReclaimedWithoutAnotherRead() {
        val inbox = HudCards("glasses", monotonic = SystemClock::elapsedRealtime)
        val terminal = packet("succeeded", "last", 100)
        inbox.accept(terminal, 0)
        assertEquals(1, backing(inbox, "activities").size)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(3500))
        assertEquals(0, backing(inbox, "activities").size)
        assertEquals(1, backing(inbox, "retiredActivityRevisions").size)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(10))
        assertEquals(0, backing(inbox, "retiredActivityRevisions").size)
        inbox.accept(terminal, 0);inbox.accept(packet("single_running", "last", 99), 0)
        assertTrue(backing(inbox, "activities").isEmpty())
        inbox.accept(packet("single_running", "fresh", 101), 0)
        assertEquals(listOf("fresh"), inbox.activities().map { it.id })
        inbox.clear()
    }
    @Test fun terminalBurstBoundsPayloadAndIdentityStorageWhileKeepingLiveWorkAndReplayIdempotency() {
        val inbox = HudCards("glasses", monotonic = SystemClock::elapsedRealtime)
        inbox.accept(packet("single_running", "live", 1), 0)
        val waiting = packet("single_running", "waiting", 2).apply { getJSONObject("card").put("state", "waiting") }
        inbox.accept(waiting, 0)
        repeat(1024) { index ->
            inbox.accept(packet("succeeded", "done-$index", index + 10L), 0)
            assertTrue(backing(inbox, "activities").size <= 66)
            assertTrue(backing(inbox, "retiredActivityRevisions").size <= 256)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(3500))
        assertEquals(setOf("live", "waiting"), backing(inbox, "activities").keys)
        inbox.accept(packet("succeeded", "done-0", 10), 0)
        assertEquals(setOf("live", "waiting"), backing(inbox, "activities").keys)
        inbox.accept(packet("single_running", "live", 3), 0)
        assertEquals(3L, inbox.activities().first { it.id == "live" }.revision)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(10))
        assertTrue(backing(inbox, "retiredActivityRevisions").isEmpty())
        inbox.accept(packet("succeeded", "done-1023", 1033), 0)
        assertEquals(setOf("live", "waiting"), backing(inbox, "activities").keys)
        inbox.clear();inbox.accept(packet("succeeded", "done-0", 10), 0)
        assertEquals(listOf("done-0"), inbox.activities().map { it.id });inbox.clear()
    }
}
