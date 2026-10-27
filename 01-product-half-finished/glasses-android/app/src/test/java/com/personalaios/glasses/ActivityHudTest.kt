package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = android.app.Application::class, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class ActivityHudTest {
    @Test fun capabilityUnknownAndWaitingDecodeAndKeepWaitingVisible() {
        for (phase in listOf("unknown", "waiting")) {
            val message = JSONObject(fixtures.getJSONObject("single_running").toString())
            val card = message.getJSONObject("card").put("state", phase).put("summary", "结果还不清楚。")
            if (phase == "unknown") card.put("completed_at", card.getString("observed_at"))
            val decoded = ActivityCard.from(message, 1000)
            assertEquals(ActivityPhase.valueOf(phase), decoded.phase)
            if (phase == "waiting") {
                assertEquals(1f, decoded.alpha(10000), 0f)
                assertEquals(decoded.elapsedMs + 9000, decoded.elapsed(10000))
            }
        }
    }
    private var now = 1000L
    private val inbox = HudCards("glasses", monotonic = { now })
    private val fixtures = JSONObject(javaClass.getResource("/activity-update.fixtures.json")!!.readText()).getJSONObject("fixtures")
    private fun packet(name: String) = JSONObject(fixtures.getJSONObject(name).toString())
    private fun accept(name: String) = inbox.accept(packet(name), 0)
    private fun state() = HudState(paired = true, activities = inbox.activities())
    private fun line(state: HudState = state(), screen: HudScreen = HudScreen.Idle, wall: Long = 0) =
        activityLine(state, screen, wall, now)

    @Test fun allSixWireFixturesTravelThroughTheLiveEnvelopeAndInbox() {
        for (name in fixtures.keys()) {
            val message = packet(name).put("schema_version", "paios.central.text-envelope.v1")
            val decoded = formalPacket(message.toString().toByteArray(), message.getString("session_id"))
            val single = HudCards("glasses", monotonic = { now })
            single.accept(decoded, 0)
            val card = single.activities().single(); val wire = message.getJSONObject("card")
            assertEquals(wire.getString("id"), card.id)
            assertEquals(wire.getString("state"), card.phase.name)
            assertEquals(wire.getLong("revision"), card.revision)
            assertEquals(wire.getString("summary"), card.summary)
            assertEquals(wire.getLong("elapsed_ms"), card.elapsed(now))
            assertEquals(message.getString("processed_event_id"), card.processedEventId)
        }
    }

    @Test fun onlyExplicitCardProgressProducesAProgressIndicator() {
        val old = packet("parallel_six")
        val item = old.getJSONObject("card").getJSONArray("items").getJSONObject(0)
        item.put("progress", JSONObject().put("version", 1).put("value", 2).put("total", 8))
        inbox.accept(old, 0)
        assertNull(inbox.activities().single().progress)
        assertNull(line()!!.progress)
        assertFalse(line()!!.text.contains("4 件在办"))
        assertFalse(line()!!.text.contains("2/6"))
        assertEquals("6 件事一起办 · 云手机等待画面", line()!!.text)

        val message = packet("single_running")
        message.getJSONObject("card").put("progress", JSONObject().put("version", 1).put("value", 2.5).put("total", 10))
        val decoded = formalPacket(message.put("schema_version", "paios.central.text-envelope.v1")
            .toString().toByteArray(), message.getString("session_id"))
        inbox.clear(); inbox.accept(decoded, 0)
        assertEquals(ActivityProgress(1, 2.5, 10.0), inbox.activities().single().progress)
        assertEquals("2.5/10", line()!!.progress!!.label)
        assertEquals("用时 18秒", line()!!.elapsed)
        now += 5000
        assertEquals("2.5/10", line()!!.progress!!.label)
        assertEquals("用时 23秒", line()!!.elapsed)
        accept("single_slow")
        assertNull(line()!!.progress)
    }

    @Test fun progressTrustBoundaryRejectsUnknownVersionsAndInvalidUnits() {
        for (wire in listOf(
            "{\"version\":2,\"value\":1,\"total\":8}",
            "{\"version\":1,\"value\":-1,\"total\":8}",
            "{\"version\":1,\"value\":0,\"total\":0}",
            "{\"version\":1,\"value\":\"2\",\"total\":8}")) {
            assertThrows(IllegalArgumentException::class.java) { ActivityProgress.from(JSONObject(wire)) }
        }
        assertEquals("0/8", ActivityProgress.from(JSONObject("{\"version\":1,\"value\":0,\"total\":8}")).label)
    }

    @Test fun revisionsReplaceWholeSnapshotsAndDuplicatesDoNotRestartClocks() {
        accept("single_running"); now += 500
        accept("single_slow"); val fresh = inbox.activities().single()
        accept("single_running"); now += 1000; accept("single_slow")
        assertEquals(fresh, inbox.activities().single())
        accept("succeeded")
        assertNull(inbox.activities().single().step)
        now += 3500; accept("succeeded"); accept("single_running")
        assertNull(line())
        inbox.clear(); assertTrue(inbox.activities().isEmpty())
    }

    @Test fun runningSlowAndParallelTextUsesPublishedCopyAndLocalElapsedTime() {
        accept("single_running")
        assertEquals("正在打开云手机 · 正在恢复千问的数据", line()!!.text)
        assertEquals("用时 18秒", line()!!.elapsed)
        now += 26999; assertFalse(line()!!.text.startsWith("这一步较慢"))
        now += 1; assertTrue(line()!!.text.contains("这一步较慢 · 30 秒没有新进度"))
        assertEquals("用时 45秒", line()!!.elapsed)
        accept("single_slow")
        assertEquals("这一步较慢 · 40 秒没有新进度 · 正在打开云手机 · 等待云手机返回画面", line()!!.text)
        assertEquals("用时 1分20秒", line()!!.elapsed)
        accept("parallel_six")
        assertEquals("6 件事一起办 · 云手机等待画面", line()!!.text)
        assertEquals("用时 32秒", line()!!.elapsed)
        assertEquals("另 1 件", line()!!.others)
        assertEquals(2, inbox.activities().size)
    }

    @Test fun newestCardShowsItsOutcomeThenRevealsOtherWork() {
        accept("parallel_six"); accept("single_running")
        assertTrue(line()!!.text.startsWith("正在打开云手机"))
        assertEquals("另 1 件", line()!!.others)
        accept("succeeded")
        assertEquals("已完成", line()!!.text)
        assertEquals("另 1 件", line()!!.others)
        now += 3500
        assertEquals("6 件事一起办 · 云手机等待画面", line()!!.text)
        assertNull(line()!!.others)
    }

    @Test fun terminalRetirementPreservesRunningWorkAndRevisionReplayScope() {
        accept("parallel_six")
        for (index in 0 until 40) {
            val terminal = packet("succeeded")
            terminal.getJSONObject("card").put("id", "terminal-$index")
            inbox.accept(terminal, 0)
        }
        assertEquals(41, inbox.activities().size)
        now += 3499
        assertEquals(41, inbox.activities().size)
        now += 1
        assertEquals(listOf("a:fixture-six"), inbox.activities().map { it.id })

        val replay = packet("succeeded").also { it.getJSONObject("card").put("id", "terminal-0") }
        inbox.accept(replay, 0)
        inbox.accept(packet("single_running").also { it.getJSONObject("card").put("id", "terminal-0") }, 0)
        assertEquals(1, inbox.activities().size)
        val newer = JSONObject(replay.toString())
        newer.getJSONObject("card").put("revision", replay.getJSONObject("card").getLong("revision") + 1)
        inbox.accept(newer, 0)
        assertEquals(2, inbox.activities().size)
        now += 3500
        inbox.accept(replay, 0)
        assertEquals(1, inbox.activities().size)
        inbox.clear()
        inbox.accept(replay, 0)
        assertEquals("terminal-0", inbox.activities().single().id)
    }

    @Test fun terminalTextHoldsForThreeSecondsThenFadesWithAFakeMonotonicClock() {
        for ((fixture, text) in listOf("succeeded" to "已完成", "failed_timeout" to "未办成 · 超时，结果未知",
            "partial_done" to "部分完成 · 1 件未办成：千问还没登录，查不到价格")) {
            inbox.clear(); accept(fixture)
            val frozen = inbox.activities().single().elapsed(now)
            assertEquals(text, line()!!.text); assertEquals(activityDuration(frozen), line()!!.elapsed)
            now += 3000
            assertEquals(1f, line()!!.alpha, 0f)
            now += 250
            assertEquals(.5f, line()!!.alpha, 0f)
            assertEquals(frozen, inbox.activities().single().elapsed(now))
            assertEquals(activityDuration(frozen), line()!!.elapsed)
            now += 250; assertNull(line())
        }
    }

    @Test fun durationHasExplicitUnitsAtMinuteAndHourBoundaries() {
        for ((milliseconds, expected) in listOf(0L to "用时 0秒", 59_999L to "用时 59秒",
            60_000L to "用时 1分00秒", 61_000L to "用时 1分01秒", 742_000L to "用时 12分22秒",
            3_599_999L to "用时 59分59秒", 3_600_000L to "用时 1小时00分00秒", 3_661_000L to "用时 1小时01分01秒")) {
            assertEquals(expected, activityDuration(milliseconds))
        }
    }

    @Test fun movementPaymentAndLiveSubtitlesOwnTheBandEvenInMenus() {
        accept("single_running"); val state = state()
        assertNull(line(state.copy(nav = JSONObject()), HudScreen.Move()))
        assertNull(line(state.copy(ride = JSONObject()), HudScreen.Menu(HudScreen.Move(), touched = 0)))
        assertNull(line(state, HudScreen.Payment))
        assertNull(line(state, HudScreen.Paying))
        assertNull(line(state.copy(paymentLock = GlassesLockState(locked = true))))
        val captions = state.copy(callId = "call", captions = listOf(HudCaption("c", "assistant", 1, "字幕", 0)))
        assertNull(line(captions, HudScreen.Talking, 4999))
        assertNotNull(line(captions, HudScreen.Talking, 5000))
        val chat = state.copy(callId = "call", conversation = CallConversation("chat"))
        assertNotNull(line(chat, HudScreen.Talking))
        assertNotNull(line(chat.copy(conversation = CallConversation("thinking", "正在处理")), HudScreen.Talking))
        assertNull(line(chat.copy(avatarPhase = "Playing"), HudScreen.Talking))
        assertNotNull(line(state, HudScreen.Menu(HudScreen.Idle, touched = 0)))
        assertNull(line(state, HudScreen.Card("confirmation")))
    }

    @Test fun legacyProgressYieldsAndCoveredWorkDoesNotReappearAfterCompletion() {
        val errand = HudCard("old-progress", "云手机", emptyList(), 1, Long.MAX_VALUE, progress = "1/3",
            ack = JSONObject().put("processed_event_id", "processed-fixture-1"))
        assertEquals(errand, legacyProgressCard(state().copy(cards = listOf(errand)), line() != null))
        accept("single_running")
        assertNull(legacyProgressCard(state().copy(cards = listOf(errand)), line() != null))
        accept("succeeded"); now += 3500
        assertTrue(inbox.activities().isEmpty())
        val retired = state().copy(cards = listOf(errand), legacyProgressCovered = inbox.legacyProgressCovered(errand))
        assertTrue(retired.legacyProgressCovered)
        assertNull(legacyProgressCard(retired, line() != null))
        val unrelated = errand.copy(ack = JSONObject().put("processed_event_id", "another-request"))
        assertEquals(unrelated, legacyProgressCard(state().copy(cards = listOf(unrelated)), line() != null))
        inbox.clear()
        assertFalse(inbox.legacyProgressCovered(errand))
        accept("single_running")
        val notice = HudCard("notice", "消息", listOf("稍后见"), 1, Long.MAX_VALUE)
        val hidden = state().copy(cards = listOf(unrelated, notice))
        val visible = line(hidden, HudScreen.Card(notice.id)) != null
        assertFalse(visible)
        assertEquals(unrelated, legacyProgressCard(hidden, visible))
    }

    @Test fun overviewReturnsToItsExistingSpotAfterActivityFades() {
        accept("succeeded"); val state = state().copy(backgroundWorkCount = 2)
        assertEquals("已完成", line(state)!!.text)
        now += 3500
        assertNull(line(state))
        assertEquals("后台事项 2 件在办", voiceStatus(state))
    }
}
