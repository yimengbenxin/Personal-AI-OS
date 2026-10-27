package com.personalaios.glasses

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE, qualifiers = "mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class MovementBootstrapTest {
    // Recorded by personal-aios-formal-text.test.ts through the real movement authority and gateway wire.
    @Test fun bootstrapPacketsRenderCurrentSegmentRideOrIdleWithinThreeSeconds() {
        val context = RuntimeEnvironment.getApplication()
        for (scenario in listOf("navigating", "riding", "idle")) for (retained in listOf(false, true)) {
            val lenses = listOf(FrameLayout(context), FrameLayout(context))
            val mirror = NavigationMirror(context, lenses[0], lenses[1], false, false) { fail(it) }
            mirror.resume()
            try {
                val started = System.nanoTime()
                val fixture = JSONObject(javaClass.getResource("/movement-bootstrap/$scenario.json")!!.readText())
                val serverNow = Instant.parse(fixture.getString("server_now")).toEpochMilli()
                var state = HudState(paired = true)
                if (retained) state = state.move(fixture.getJSONObject("previous"), 900, serverNow)
                val packets = fixture.getJSONArray("packets")
                for (i in 0 until packets.length()) state = state.move(packets.getJSONObject(i), 1000, serverNow)
                state = visibleHud(state, 1000, serverNow)
                val layout = moveHudLayout(state)
                val map = state.navigationFix?.mapState(state.navigationRoute!!,
                    HeadingSample(0f, HeadingAccuracy.HIGH, 1000), MiniMapStyle.ROUTE_ONLY)
                mirror.update(map, layout)
                if (scenario == "navigating") {
                    assertNull(state.ride)
                    val wire = packets.getJSONObject(1).getJSONObject("nav")
                    assertEquals(wire.getInt("route_segment_index"), state.navigationFix!!.segmentIndex)
                    assertEquals(wire.getDouble("segment_fraction"), state.navigationFix!!.segmentFraction, 0.0)
                    assertEquals("1.0km", layout.texts.single { it.role == "navigation" }.text)
                    assertTrue(layout.texts.single { it.role == "navigation_road" }.text.startsWith("左转"))
                    assertNotNull(map); assertEquals(0L, state.routeOverviewUntil)
                } else if (scenario == "riding") {
                    assertNull(state.nav); assertEquals("18.0", layout.texts.single { it.role == "speed" }.text)
                } else {
                    assertNull(state.ride); assertNull(state.nav); assertNull(state.navigationFix)
                    assertTrue(layout.texts.isEmpty()); assertEquals(HudScreen.Idle, reconcileHud(HudScreen.Move(), state))
                }
                val bitmaps = lenses.map { lens ->
                    layout.texts.forEach { text -> lens.addView(moveHudTextView(context, text, false, Color.WHITE, Color.GRAY),
                        FrameLayout.LayoutParams(text.rect.width, text.rect.height).apply {
                            leftMargin = text.rect.x; topMargin = text.rect.y
                        }) }
                    lens.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
                    lens.layout(0, 0, 640, 480)
                    Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).also { lens.draw(Canvas(it)) }
                }
                val elapsedMs = (System.nanoTime() - started) / 1_000_000
                assertTrue("$scenario retained=$retained rendered in $elapsedMs ms", elapsedMs < 3000)
                assertTrue(bitmaps[0].sameAs(bitmaps[1]))
                if (scenario == "navigating") {
                    assertEquals(View.VISIBLE, mirror.hosts[0].visibility)
                    assertEquals("导航路线图，无街道底图", mirror.hosts[0].contentDescription)
                    assertTrue(Color.alpha(bitmaps[0].getPixel(528, 362)) > 0)
                }
                println("bootstrap render $scenario retained=$retained: $elapsedMs ms (no subsequent frame)")
                System.getenv("MOVE_SCREENSHOT_DIR")?.let { directory ->
                    File(directory).mkdirs()
                    File(directory, "bootstrap-$scenario-$retained.png").outputStream().use {
                        bitmaps[0].compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                }
                bitmaps.forEach(Bitmap::recycle)
            } finally { mirror.destroy() }
        }
    }
}
