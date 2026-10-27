package com.personalaios.glasses

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.hardware.*
import android.os.*
import android.text.SpannableStringBuilder
import android.text.TextUtils
import android.text.style.*
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.content.ContextCompat
import androidx.core.text.inSpans
import androidx.core.view.doOnPreDraw
import androidx.core.view.children
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.ffalcon.mercury.android.sdk.core.make3DEffectForSide
import com.ffalcon.mercury.android.sdk.focus.reqFocus
import com.ffalcon.mercury.android.sdk.touch.TempleAction
import com.ffalcon.mercury.android.sdk.ui.activity.BaseMirrorActivity
import com.ffalcon.mercury.android.sdk.ui.util.*
import com.personalaios.glasses.databinding.ActivityMainBinding
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

class MainActivity : BaseMirrorActivity<ActivityMainBinding>(), SensorEventListener {
    private val avatarView by lazy { AvatarPlaceholder(this, mBindingPair.left.lens, mBindingPair.right.lens) }
    private var navigationMirror: NavigationMirror? = null
    private var headingSample: HeadingSample? = null
    private val navigationHeading by lazy { HeadHeading(this) { sample ->
        headingSample = sample; updateNavigationMap()
    } }
    private val enrollment by lazy { Enrollment(this) }
    private val sensors by lazy { getSystemService(SensorManager::class.java) }
    private val head = HeadMotion()
    private var headCard: HudScreen.Card? = null
    private var hud = HudState()
    private var screen: HudScreen = HudScreen.Pairing()
    private var tracker: FixPosFocusTracker? = null
    private var scan: Job? = null
    private var scanRecognized = false
    private var afterPermission = "CONNECT"
    private var rendered: String? = null
    private val companionRendered = linkedSetOf<String>()
    private var presented: HudScreen? = null
    private var presentedCard: HudCard? = null
    private var presentedMenu = emptyList<HudMenuItem>()
    private var presentedCallId: String? = null
    private var noticeId: String? = null
    private var noticeSince = 0L
    private var lastContent = monotonicMillis()
    private var hintUntil = 0L
    private var showHint = false
    private val timer = Handler(Looper.getMainLooper())
    private var nextDraw = Long.MAX_VALUE
    private var lastDraw = 0L
    private val draw = Runnable { nextDraw = Long.MAX_VALUE; render() }
    private val yimi get() = getColor(R.color.optical_accent)
    private val ink get() = getColor(R.color.optical_text)
    private val ink2 get() = getColor(R.color.optical_secondary)
    private val ink3 get() = getColor(R.color.optical_hint)
    private val danger get() = getColor(R.color.optical_danger)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.w("Yimi", "activity_create restored=${savedInstanceState != null}")
        if (savedInstanceState != null) intent.removeExtra("pay")
        File(filesDir, "e2ee-recipient-registration.v1.json").writeText(enrollment.registrationText())
        val imported = File(filesDir, "device-pairing.v1.json")
        if (imported.exists()) try {
            check(!CompanionService.state.value.listening && !CompanionService.state.value.busy) { "先停止当前连接" }
            enrollment.importPairing(imported.readText(), DEFAULT_GATEWAY); check(imported.delete())
            CompanionService.state.value = CompanionService.state.value.copy(avatar = null)
        } catch (error: Exception) { screen = HudScreen.ScanFailed(error.message ?: "配对文件无法使用") }
        hud = CompanionService.state.value.copy(paired = enrollment.isPaired)
        screen = reconcileHud(screen, hud)
        showHint = enrollment.recordLaunch() <= 3
        render()
        mBindingPair.updateView {
            val logo = ImageView(this@MainActivity).apply { tag = "brand_open"; setImageResource(R.drawable.yimi_lockup); contentDescription = "依米" }
            place(lens, logo, 162, 20, 316, 96)
            logo.alpha = 0f
            logo.animate().alpha(1f).setDuration(180).withEndAction {
                logo.animate().alpha(0f).setStartDelay(300).setDuration(420).withEndAction { lens.removeView(logo) }.start()
            }.start()
        }
        lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.RESUMED) {
            launch { CompanionService.state.collect { state ->
                val incoming = state.copy(paired = enrollment.isPaired)
                val changed = incoming.cards.lastOrNull()?.copy(ack = null) != hud.cards.lastOrNull()?.copy(ack = null)
                val known = hud.cards.map { it.id }.toSet()
                val fresh = incoming.cards.any { it.progress == null && it.id !in known }
                if (changed || incoming.callId != hud.callId) lastContent = monotonicMillis()
                if (incoming.summary != null && incoming.summary !== hud.summary) screen = HudScreen.Summary(incoming.summaryAt)
                hud = incoming
                if (changed) screen = reconcileHud(screen, visibleHud(hud, monotonicMillis(), ServerClock.shared.nowMillis()), fresh)
                schedule(0)
            } }
            launch { templeActionViewModel.state.collect(::temple) }
        } }
        if (enrollment.companionEnabled) permit()
    }
    // pay_open arrives as our launch intent with "pay"; the first resume after Alipay sends pay_closed.
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) }
    override fun onResume() { super.onResume(); navigationMirror?.resume(); CompanionService.avatarHosts.value = avatarView.hosts; dispatch(if (intent.getBooleanExtra("pay", false)) HudGesture.Pay.also { intent.removeExtra("pay") } else HudGesture.Resume) }
    override fun onPause() {
        Log.w("Yimi", "activity_pause finishing=$isFinishing")
        if (CompanionService.avatarHosts.value === avatarView.hosts) CompanionService.avatarHosts.value = null
        if (scan != null) { scan?.cancel(); screen = HudScreen.Pairing() }
        navigationHeading.stop(); headingSample = null; navigationMirror?.pause()
        sensors.unregisterListener(this); headCard = null; head.reset()
        timer.removeCallbacks(draw); nextDraw = Long.MAX_VALUE
        super.onPause()
    }
    override fun onDestroy() { Log.w("Yimi", "activity_destroy finishing=$isFinishing"); CompanionService.paying = false; timer.removeCallbacks(draw); navigationHeading.stop(); navigationMirror?.destroy(); super.onDestroy() }
    override fun onBackPressed() { dispatch(HudGesture.DoubleClick) }

    private fun temple(action: TempleAction) {
        // FixPosFocusTracker supports one axis. The reducer owns selection; render projects it into the holder.
        val slide = when (action) {
            is TempleAction.SlideForward -> HudGesture.Forward
            is TempleAction.SlideBackward -> HudGesture.Backward
            is TempleAction.SlideUpwards -> HudGesture.Up
            is TempleAction.SlideDownwards -> HudGesture.Down
            else -> null
        }
        if (slide != null) dispatch(slide)
        else if (action is TempleAction.Click || action is TempleAction.DoubleClick) tracker!!.handleFocusTargetEvent(action)
    }
    private fun dispatch(gesture: HudGesture, focus: Int? = null) {
        val state = visibleHud(hud, monotonicMillis(), ServerClock.shared.nowMillis())
        screen = reconcileHud(screen, state)
        if (gesture == HudGesture.Click || gesture == HudGesture.Nod || gesture == HudGesture.Shake ||
            gesture == HudGesture.DoubleClick) {
            val liveCard = presentedCard?.let { shown -> state.cards.firstOrNull { it.id == shown.id } }
            if (hud.callId != presentedCallId || screen != presented || presentedCard?.copy(ack = null) != liveCard?.copy(ack = null) ||
                screen is HudScreen.Menu && hudMenu(state, (screen as HudScreen.Menu).modeChoices) != presentedMenu) { schedule(0); return }
        }
        if (focus != null) screen = when (val current = screen) {
            is HudScreen.Menu -> current.copy(focus = focus)
            is HudScreen.Settings -> current.copy(focus = focus)
            is HudScreen.Consent -> current.copy(focus = focus)
            else -> current
        }
        val result = reduceHud(screen, gesture, state, monotonicMillis())
        screen = result.screen; lastContent = monotonicMillis()
        when (result.action) {
            "SCAN" -> if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) enroll()
                else requestPermissions(arrayOf(Manifest.permission.CAMERA), 3)
            "CANCEL_SCAN" -> scan?.cancel()
            "TAP", "NAV" -> { afterPermission = "TAP"; permit() }
            // Our own task, explicit component plus action: when Alipay finishes, 依米 is in front again without reopening.
            "PAY" -> try { render(); startActivity(Intent("com.eg.android.AlipayGGlasses.Scan")
                .setClassName("com.eg.android.AlipayGGlasses", "com.alipay.InnerScanApi.GlassesTransparentActivity")) }
                catch (_: ActivityNotFoundException) {
                    send("PAY_CLOSED")
                    screen = HudScreen.Notice("这副眼镜没装支付宝", monotonicMillis() + 3000)
                }
            "AMBIENT_ON", "AMBIENT_OFF" -> send("AMBIENT", detail = if (result.action == "AMBIENT_ON") "on" else "off")
            "AVATAR_ON", "AVATAR_OFF" -> send("AVATAR", detail = if (result.action == "AVATAR_ON") "on" else "off")
            "MAP_AGREE", "MAP_DECLINE" -> {
                enrollment.mapPrivacyChoice = result.action == "MAP_AGREE"
                navigationMirror?.destroy(); navigationMirror = null
            }
            "TEXT_SIZE" -> enrollment.largeText = !enrollment.largeText
            "REPAIR" -> send("DISCONNECT", clearEnrollment = true)
            "FINISH" -> {
                // Retain the activity task when returning to the launcher.
                val moved = moveTaskToBack(true)
                Log.w("Yimi", "activity_background moved=$moved")
            }
            null -> Unit
            else -> send(result.action, result.cardId, result.actionId)
        }
        CompanionService.paying = screen == HudScreen.Paying
        schedule(0)
    }
    private fun updateNavigationMap(visible: HudState = visibleHud(hud, monotonicMillis(), ServerClock.shared.nowMillis()),
        layout: MoveHudLayout? = (screen as? HudScreen.Move)?.let { moveHudLayout(visible, it.page, enrollment.largeText) }) {
        val route = visible.navigationRoute; val fix = visible.navigationFix; val heading = headingSample
        navigationMirror?.update(if (screen is HudScreen.Move && visible.nav != null && route != null && visible.routeOverviewUntil > 0)
            route.overviewMap()
            else if (screen is HudScreen.Move && visible.nav != null && route != null && fix != null && heading != null)
            fix.mapState(route, heading, if (enrollment.mapPrivacyChoice == true) MiniMapStyle.STREETS else MiniMapStyle.ROUTE_ONLY) else null,
            layout)
    }
    private fun enroll() {
        val previous = scan
        scan = lifecycleScope.launch {
            try {
                previous?.cancelAndJoin()
                check(!hud.listening && !hud.busy && enrollment.controlJournal() == null) { "先停止旧连接，再扫描配对码" }
                val payload = scanEnrollment(this@MainActivity)
                // The code is read; the exchange with the gateway can take seconds, so say so at once.
                scanRecognized = true; schedule(0)
                enrollment.exchange(payload, DEFAULT_GATEWAY)
                CompanionService.state.value = CompanionService.state.value.copy(avatar = null)
                hud = hud.copy(paired = true); screen = HudScreen.Paired(monotonicMillis() + 2000)
                afterPermission = "CONNECT"; permit()
            } catch (_: TimeoutCancellationException) { screen = HudScreen.ScanFailed("没认出配对码，请靠近 iPhone 重新扫描") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { screen = HudScreen.ScanFailed(error.message?.lineSequence()?.first() ?: "配对失败，请重新扫描") }
            finally { if (scan == currentCoroutineContext()[Job]) { scan = null; scanRecognized = false }; schedule(0) }
        }
    }
    private fun permit() {
        val missing = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) send(afterPermission) else requestPermissions(missing.toTypedArray(), 1)
    }
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 3 && screen == HudScreen.Scanning) {
            if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) enroll()
            else screen = HudScreen.ScanFailed("允许相机后才能扫描配对码")
        }
        if (code == 1) {
            if (results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED }) send(afterPermission)
            else screen = HudScreen.Notice("允许麦克风和相机后，再单击和我说话", monotonicMillis() + 3000)
        }
        schedule(0)
    }
    private fun send(action: String, cardId: String? = null, detail: String? = null, clearEnrollment: Boolean = false) {
        ContextCompat.startForegroundService(this, Intent(this, CompanionService::class.java).apply {
            this.action = action
            if (action in setOf("AVATAR", "CAMERA", "MUTE", "STOP", "MODE_CHAT", "MODE_THINKING", "THINK_RETRY", "THINK_CHAT")) hud.callId?.let { putExtra("call_id", it) }
            cardId?.let { putExtra("card_id", it) }
            detail?.let {
                if (action in setOf("AMBIENT", "AVATAR")) putExtra("on", it == "on")
                else putExtra(if (action == "APPROVE") "action_id" else "receipt", it)
            }
            if (clearEnrollment) putExtra("clear_enrollment", true)
        })
    }
    private fun schedule(delay: Long) {
        val at = SystemClock.uptimeMillis() + maxOf(delay, 34 - (SystemClock.uptimeMillis() - lastDraw))
        if (at < nextDraw) { timer.removeCallbacks(draw); nextDraw = at; timer.postAtTime(draw, at) }
    }

    private fun render() {
        lastDraw = SystemClock.uptimeMillis()
        val now = monotonicMillis()
        val hud = visibleHud(this.hud, now, ServerClock.shared.nowMillis())
        screen = reconcileHud(settleHud(screen, now), hud)
        if (screen is HudScreen.Move && !hud.paymentLock.locked && hud.routeOverviewUntil == 0L && hud.nav != null && BuildConfig.AMAP_CONFIGURED && enrollment.mapPrivacyChoice == null)
            screen = HudScreen.Consent(screen, navigation = true)
        hud.routeOverviewUntil.takeIf { it > now }?.let { schedule(it - now) }
        val base = (screen as? HudScreen.Menu)?.under ?: screen
        val moveLayout = if (base is HudScreen.Move) moveHudLayout(hud, base.page, enrollment.largeText, screen is HudScreen.Menu) else null
        val navigating = screen is HudScreen.Move && hud.nav != null
        if (navigating) {
            if (navigationMirror == null) navigationMirror = NavigationMirror(this, mBindingPair.left.lens, mBindingPair.right.lens,
                enrollment.mapPrivacyChoice != null, enrollment.mapPrivacyChoice == true) { Log.w("Yimi", it) }.also {
                    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) it.resume()
                }
            hud.navigationFix?.let { navigationHeading.updateTrueNorthLocation(it.latitude, it.longitude, it.altitude, it.sampleTime) }
            if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) navigationHeading.start()
        } else navigationHeading.stop()
        updateNavigationMap(hud, moveLayout)
        val lockLine = hud.paymentLock.line(now)
        val activity = activityLine(hud, screen, now, SystemClock.elapsedRealtime())
        if (activity != null) schedule(activity.nextUpdateMs)
        val companion = companionReplyLine(hud, screen, now, activity != null)
        if (companion != null) schedule(companion.nextUpdateMs)
        val specialBand = base is HudScreen.Consent || base is HudScreen.Appearance || base == HudScreen.Locked || base == HudScreen.Payment || base is HudScreen.VoiceEnrolment || base is HudScreen.VoiceSupplement || lockLine != null
        avatarView.hosts.forEach { it.alpha = if (base == HudScreen.Talking && !specialBand && hud.conversation?.mode != "thinking") 1f else 0f }
        if (base == HudScreen.Idle && showHint) { showHint = false; hintUntil = now + 3000 }
        // On the ride summary, 依米's remark (her reply to the ride end) is the line under the numbers.
        val card = (base as? HudScreen.Card)?.let { shown -> hud.cards.first { it.id == shown.id } }
            ?: (base as? HudScreen.Summary)?.let { hud.cards.lastOrNull { it.progress == null && it.actions.isEmpty() } }
        val choice = card != null && card.actions.size >= 2
        // Nod/shake answer choices, but never while riding: the road shakes the head.
        val headTarget = (screen as? HudScreen.Card)?.takeIf { choice && hud.ride == null && hud.capture.worn == true && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        if (headTarget != headCard) {
            sensors.unregisterListener(this); head.reset(); headCard = headTarget
            if (headTarget != null)
                sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
        }
        val targets = mutableListOf<View>()
        val cardText = mutableListOf<TextView>()
        val companionViews = mutableListOf<CompanionReplyHud>()
        var selected = 0
        mBindingPair.updateView {
            val lens = this.lens
            lens.children.filter { it.tag != AvatarPlaceholder.TAG && it.tag != "brand_open" && it.tag != NavigationMirror.TAG }.toList().forEach(lens::removeView)
            val left = mBindingPair.checkIsLeft(this)
            val controls = mutableListOf<View>()
            fun button(title: String, x: Int, y: Int, width: Int, height: Int, index: Int, focus: Int,
                icon: Int = 0, color: Int = ink2, value: String? = null, pad: Int = 14, controlId: Int = View.NO_ID, targetFocus: Int = index) {
                val tint = if (color == danger) danger else if (index == focus) ink else color
                val row = LinearLayout(this@MainActivity).apply {
                    contentDescription = listOfNotNull(title, value).joinToString(" · ")
                    id = when (title) {
                        "挂断", "结束通话" -> R.id.voice_end_call
                        "静音", "取消静音" -> R.id.voice_mute
                        "本地唤醒" -> R.id.voice_local_wake
                        else -> View.NO_ID
                    }
                    gravity = if (icon == 0 && value == null) Gravity.CENTER else Gravity.CENTER_VERTICAL
                    setPadding(dp(if (value == null) pad else 18), 0, dp(if (value == null) pad else 18), 0)
                    if (icon != 0) addView(ImageView(context).apply { setImageResource(icon); imageTintList = ColorStateList.valueOf(tint) },
                        LinearLayout.LayoutParams(dp(22), dp(22)).apply { marginEnd = dp(10) })
                    addView(label(title, if (value == null) 16 else 18, tint), LinearLayout.LayoutParams(if (value == null) -2 else dp(170), -2))
                    if (value != null) addView(label(value, color = ink3, lines = 2).apply { gravity = Gravity.END }, LinearLayout.LayoutParams(0, -2, 1f))
                }
                if (controlId != View.NO_ID) row.id = controlId
                row.contentDescription = listOfNotNull(title, value).joinToString(" · ")
                row.setOnClickListener { dispatch(HudGesture.Click, targetFocus) }
                row.background = GradientDrawable().apply { setColor(Color.TRANSPARENT); cornerRadius = dp(14).toFloat(); if (index == focus) setStroke(dp(2), yimi) }
                make3DEffectForSide(row, left, index == focus, dp(3).toFloat())
                place(lens, row, x, y, width, height); controls += row
                if (left) selected = focus
            }
            fun centered(text: String, y: Int, size: Int = 16, color: Int = ink3, height: Int = 28, bold: Boolean = false) =
                place(lens, label(text, size, color, bold, 2).apply { gravity = Gravity.CENTER }, 30, y, 580, big(height))
            fun face(x: Int, y: Int, size: Int, halo: Int, dim: Boolean = false) {
                if (halo > 0) place(lens, View(this@MainActivity).apply { background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(dp(6), 0x4D5B86FF)
                } }, x - halo, y - halo, size + 2 * halo, size + 2 * halo)
                place(lens, ImageView(this@MainActivity).apply {
                    val portrait = hud.avatar
                    if (portrait == null) { setImageResource(R.drawable.yimi_face); scaleType = ImageView.ScaleType.CENTER_CROP }
                    else {
                        setImageBitmap(portrait.bitmap); scaleType = ImageView.ScaleType.MATRIX
                        doOnPreDraw {
                            val width = (width - paddingLeft - paddingRight).toFloat()
                            val height = (height - paddingTop - paddingBottom).toFloat()
                            val scale = maxOf(width / portrait.bitmap.width, height / portrait.bitmap.height)
                            val scaledWidth = portrait.bitmap.width * scale; val scaledHeight = portrait.bitmap.height * scale
                            imageMatrix = android.graphics.Matrix().apply {
                                setScale(scale, scale)
                                postTranslate(minOf(0f, maxOf(width - scaledWidth, width / 2 - scaledWidth * portrait.profile.x.toFloat())),
                                    minOf(0f, maxOf(height - scaledHeight, height / 2 - scaledHeight * portrait.profile.y.toFloat())))
                            }
                        }
                    }
                    setPadding(dp(2), dp(2), dp(2), dp(2)); clipToOutline = true
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.BLACK) }
                    foreground = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(dp(2), yimi) }
                    alpha = if (dim) .5f else 1f
                }, x, y, size, size)
            }
            // 依米's line (⑭ under the numbers, ⑮ centred): her portrait with the live ring, then 18sp bold.
            fun say(text: String, y: Int, centred: Boolean = false) = label(text, 18, ink, true).also { line ->
                val x = if (!centred) 30 else (320 - (40 + (line.paint.measureText(text) / resources.displayMetrics.density).toInt()) / 2).coerceAtLeast(30)
                face(x - 2, y - 2, 34, 4)
                place(lens, LinearLayout(this@MainActivity).apply { gravity = Gravity.CENTER_VERTICAL; addView(line) }, x + 40, y, 570 - x, 30)
            }
            val callMode = conversationLabel(hud)
            val thinkingText = hud.conversation?.text ?: hud.conversationError?.let { "切换失败：$it" }
            if (base !is HudScreen.Settings && base !is HudScreen.Summary && base != HudScreen.Paying && moveLayout == null) {
                val live = hud.callId != null
                if (!live && activity == null && companion == null) face(28, 18, 40, 0, base == HudScreen.Idle && now - lastContent >= 10000)
                if (base is HudScreen.Pairing || base == HudScreen.Scanning || base is HudScreen.ScanFailed || base is HudScreen.Paired) {
                    place(lens, label("依米", 18, yimi, true), 76, 20, 220, big(28))
                    val status = if (base == HudScreen.Scanning) (if (scanRecognized) "正在配对" else "正在找二维码") else if (hud.paired) "在呢" else "还没连上手机"
                    val stateY = if (enrollment.largeText) 47 else 43
                    place(lens, label(status), 91, stateY, 300, big(26))
                    place(lens, View(this@MainActivity).apply { background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL; setColor(if (base == HudScreen.Scanning) yimi else ink3)
                    } }, 76, stateY + 6, 8, 8)
                } else if (specialBand) {
                    // The lock and payment notice own this band. No chat, caption or progress is drawn underneath.
                } else if (companion != null) {
                    val view = CompanionReplyHud(this@MainActivity, companion, hud.avatar, activity)
                    lens.addView(view); companionViews.add(view)
                } else if (activity != null) {
                    lens.addView(activityLineView(this@MainActivity, activity))
                } else if (card == null && !live) {
                    val hasWorkStatus = hud.callEnded || (hud.backgroundWorkCount ?: 0) > 0
                    val status = if (hasWorkStatus) voiceStatus(hud) else "依米 · ${if (hud.listening) "已连接" else "正在连接"}"
                    place(lens, label(status, 18, ink, true).apply {
                        if (hasWorkStatus) { id = R.id.voice_status; contentDescription = text }
                    }, 82, 20, 528, big(26))
                    val display = ambientDisplay(hud, now)
                    place(lens, label(display.text, color = ink, lines = if (display.text.startsWith("错误")) 2 else 1).apply { id = R.id.ambient_status }, 82, 50, 528, big(if (display.text.startsWith("错误")) 54 else 26))
                    val detail = if (hud.recording) {
                        if (hud.listening && hud.microphoneApplied == Microphone.On) "正在录音" else "录音等待确认 · 可停止后重试"
                    } else if (hasWorkStatus) {
                        if (wakeTaps(hud) && hud.localWake == LocalWakeState.LocalReady) "本地待命 · 仅本机" else localWakeStatus(hud)
                    } else voiceStatus(hud)
                    if (!display.text.startsWith("错误")) place(lens, label(detail).apply {
                        if (!hasWorkStatus) id = R.id.voice_status
                        contentDescription = text
                    }, 82, 80, 528, big(26))
                    if (display.text == "等待确认") schedule(1000)
                } else if (card == null) {
                    val x = if (hud.avatarPhase == "Playing" && hud.conversation?.mode != "thinking") 194 else 30
                    if (callMode == null) place(lens, label(voiceStatus(hud), 18, ink, true).apply {
                        id = R.id.voice_status; contentDescription = text
                    }, x, 20, 610 - x, big(26))
                    val camera = when (val value = cameraLabel(hud)) {
                        "关" -> "镜头已关"
                        "开" -> "前方镜头共享中"
                        else -> "前方镜头$value"
                    }
                    place(lens, label(if (hud.conversation?.mode == "thinking") camera else "数字人${avatarLabel(hud)} · $camera", lines = 1), x, 50, 610 - x, big(26))
                    hud.captions.lastOrNull()?.let { caption ->
                        val age = now - hud.captions.maxOf { it.at }
                        place(lens, label(caption.text, 20, ink, true).apply { alpha = captionAlpha(age) }, x, 80, 610 - x, big(30))
                        schedule(if (age < 4000) 4000 - age else 100)
                    }
                }
                legacyProgressCard(hud, activity != null || companion != null)?.takeIf { !specialBand && (base == HudScreen.Idle || base is HudScreen.Move || screen is HudScreen.Menu || card != null && !choice) }?.let { errand ->
                    val (current, total) = errand.progress!!.split('/').map(String::toInt)
                    fun ring(color: Int, leveled: Boolean) = GradientDrawable().apply {
                        shape = GradientDrawable.RING; innerRadius = dp(6); thickness = dp(4); setColor(color); useLevel = leveled
                    }
                    val chip = LinearLayout(this@MainActivity).apply {
                        gravity = Gravity.CENTER_VERTICAL
                        addView(ImageView(context).apply {
                            setImageDrawable(LayerDrawable(arrayOf(ring(ink3, false), ring(yimi, true))))
                            setImageLevel((current * 10000L / total).toInt()); rotation = -90f
                        }, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) })
                        val elapsed = ((now - errand.startedAt) / 1000).coerceAtLeast(0)
                        addView(label(errand.title), LinearLayout.LayoutParams(0, -2, 1f))
                        addView(label(" · ${elapsed / 60}:${(elapsed % 60).toString().padStart(2, '0')}"))
                    }
                    lens.addView(chip, FrameLayout.LayoutParams(dp(156), dp(28), Gravity.TOP or Gravity.END).apply { topMargin = dp(22); rightMargin = dp(30) })
                    schedule(1000)
                }
            }
            if (lockLine != null && base !is HudScreen.VoiceEnrolment && base !is HudScreen.VoiceSupplement && base !is HudScreen.Settings && base != HudScreen.Paying) {
                place(lens, label(lockLine, 20, ink, true, 2), 78, 18, 532, big(60))
                if (hud.paymentLock.awaitingPhone) place(lens, label("随身模式和通话照常 · 单击重新请求", color = ink3, lines = 2), 78, 82, 532, big(48))
            }
            when (val current = base) {
                HudScreen.Payment -> hud.payment?.let { notice ->
                    val amount = LinearLayout(this@MainActivity).apply {
                        gravity = Gravity.CENTER_VERTICAL
                        addView(label(notice.payee.orEmpty(), 20, ink, true), LinearLayout.LayoutParams(0, -2, 1f))
                        addView(label(notice.amountText.orEmpty(), 20, ink, true), LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
                    }
                    val lines = listOfNotNull(label(notice.title, 16, yimi, true),
                        amount.takeIf { notice.amountLine.isNotEmpty() },
                        notice.line?.let { label(it, color = ink2) }, notice.hint?.let { label(it, color = ink, lines = 2) })
                    place(lens, column(Gravity.START, 4, *lines.toTypedArray()), 78, 18, 532, big(128))
                }
                is HudScreen.VoiceEnrolment -> {
                    val voice = hud.voiceEnrollment
                    val title = if (voice.sentences.isEmpty() || voice.phase == VoiceEnrollmentPhase.Enrolled) "我的声音"
                        else "我的声音 · 第 ${voice.index + 1} / ${voice.sentences.size} 句"
                    centered(title, 22, 20, ink, bold = true)
                    val prompt = when (voice.phase) {
                        VoiceEnrollmentPhase.Enrolled -> "已好 ${voice.good} / ${voice.sentences.size} 句"
                        VoiceEnrollmentPhase.AwaitingPhone, VoiceEnrollmentPhase.Expired, VoiceEnrollmentPhase.Failed -> "只有你本人该点 · 手机上要 Face ID"
                        else -> voice.sentence ?: "请在 iPhone 上确认"
                    }
                    place(lens, label(prompt, 16, ink, lines = 8)
                        .apply { gravity = Gravity.CENTER }, 30, 84, 580, 220)
                    centered(voice.message, 320, 18, ink, 56, true)
                    centered(if (voice.phase == VoiceEnrollmentPhase.Enrolled) "说「付吧」还需已解锁并开启声纹支付" else "已好 ${voice.good} 句 · 双击取消返回", 376)
                    val action = when (voice.phase) {
                        VoiceEnrollmentPhase.Recording -> "结束这句"
                        VoiceEnrollmentPhase.Result -> if (voice.canFinish && voice.good == voice.sentences.size) "完成录入" else "继续读"
                        VoiceEnrollmentPhase.Enrolled -> "完成"
                        VoiceEnrollmentPhase.Expired, VoiceEnrollmentPhase.Failed -> "重新申请"
                        VoiceEnrollmentPhase.Ready -> "开始读"
                        else -> "请稍候"
                    }
                    button(action, if (voice.canFinish) 140 else 250, 414, 140, 46, 0, if (current.finish) 1 else 0)
                    if (voice.canFinish) button("完成录入", 330, 414, 170, 46, 1, if (current.finish) 1 else 0)
                }
                is HudScreen.VoiceSupplement -> {
                    val voice = hud.voiceSupplement
                    centered("补充声音", 22, 20, ink, bold = true)
                    val progress = when (voice.phase) {
                        VoiceSupplementPhase.Idle, VoiceSupplementPhase.AwaitingPhone, VoiceSupplementPhase.Failed -> "只有你本人该允许 · 不用于付款"
                        else -> "已收集清晰语音 ${voice.cleanMs / 1000} / ${voice.targetMs / 1000} 秒"
                    }
                    place(lens, label(progress, 16, ink, lines = 3).apply { gravity = Gravity.CENTER }, 30, 96, 580, 120)
                    centered(voice.message, 240, 18, ink, 56, true)
                    centered("双击取消返回 · 原有声音保留到新录音保存", 376)
                    val action = when (voice.phase) {
                        VoiceSupplementPhase.Idle, VoiceSupplementPhase.Failed -> "申请"
                        VoiceSupplementPhase.Talking -> "结束并检查"
                        VoiceSupplementPhase.Paused -> if (voice.cleanMs >= voice.targetMs) "检查" else "继续聊"
                        VoiceSupplementPhase.Checked -> "保存"
                        VoiceSupplementPhase.Saved -> "完成"
                        else -> "请稍候"
                    }
                    button(action, 250, 414, 140, 46, 0, 0)
                }
                is HudScreen.Pairing -> {
                    val guide = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
                    val steps = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                    guide.addView(label("和 iPhone 配对", 22, ink, true).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, -2))
                    listOf("在 iPhone 依米首页，点右上角「设备」→「添加眼镜」", "单击镜腿，然后看向手机上的二维码").forEachIndexed { i, step ->
                        val row = LinearLayout(this@MainActivity).apply {
                            gravity = Gravity.CENTER_VERTICAL
                            addView(label("${i + 1}", color = yimi).apply {
                                gravity = Gravity.CENTER; background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(dp(2), yimi) }
                            }, LinearLayout.LayoutParams(dp(if (enrollment.largeText) 28 else 24), dp(if (enrollment.largeText) 28 else 24)).apply { marginEnd = dp(10) })
                            addView(label(step, lines = 2), LinearLayout.LayoutParams(-2, -2))
                        }
                        steps.addView(row, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(if (i == 0) 16 else 4) })
                    }
                    guide.addView(steps, LinearLayout.LayoutParams(-2, -2))
                    place(lens, guide, 30, 110, 580, 240)
                    centered("单击确认 · 双击退出", 360)
                    listOf("扫描配对码", "连接设置").forEachIndexed { i, title ->
                        button(title, if (i == 0) (if (enrollment.largeText) 151 else 167) else 333, 408,
                            (if (i == 0) 152 else 140) + if (enrollment.largeText) 16 else 0, 52, i, current.focus,
                            if (i == 0) R.drawable.ic_scan else R.drawable.ic_settings, pad = 20)
                    }
                }
                HudScreen.Scanning -> {
                    place(lens, ImageView(this@MainActivity).apply {
                        setImageResource(R.drawable.scan_frame)
                        // The frame breathes while it looks, so the owner sees the scan is running.
                        if (!scanRecognized) android.animation.ObjectAnimator.ofFloat(this, View.ALPHA, 1f, .35f).apply {
                            duration = 800; repeatMode = android.animation.ValueAnimator.REVERSE; repeatCount = android.animation.ValueAnimator.INFINITE
                        }.start()
                    }, 220, 111, 200, 200)
                    if (scanRecognized) {
                        centered("认出来了，正在配对…", 334, color = ink)
                        centered("可以放下手机了", 360)
                    } else {
                        centered("看向 iPhone 上的二维码", 334, color = ink)
                        centered("保持手机屏幕亮着，离眼镜二三十厘米最好认", 360)
                    }
                    button("取消", 268, 408, 104, 52, 0, 0, pad = 20)
                }
                is HudScreen.ScanFailed -> {
                    centered(current.reason, 206, color = ink, height = 70)
                    button("重新扫描", 250, 408, 140, 52, 0, 0, R.drawable.ic_scan, pad = 20)
                }
                is HudScreen.Paired -> {
                    place(lens, ImageView(this@MainActivity).apply { setImageResource(R.drawable.ic_check) }, 301, 181, 38, 38)
                    centered("配好了", 237, 20, ink, 32, true); schedule(current.until - now)
                }
                is HudScreen.Notice -> {
                    place(lens, label(current.text, 20, ink, true, 2), 78, 18, 532, 90); schedule(current.until - now)
                }
                is HudScreen.Consent -> {
                    centered(if (current.navigation) "开启高德街道图？" else if (current.avatar) "开启数字人？" else "打开随身记录？", 20, 20, ink, 30, true)
                    val text = if (current.navigation) "高德地图 SDK 会处理位置与设备信息，用于显示街道底图。隐私政策：lbs.amap.com/pages/privacy/。同意后开启街道图；也可只看路线。"
                        else if (current.avatar) "开启数字人可能产生费用，按当前服务计费。确认后等待画面，当前通话与前方镜头继续。"
                        else "开启后，眼镜会自动记录声音与第一视角画面，并上传保存。摘下眼镜也会继续随身记录。你随时可以从菜单关闭。"
                    place(lens, label(text, 18, ink, lines = if (current.navigation) 6 else 3), 30, 62, 580, big(if (current.navigation) 180 else 94))
                    val consentY = if (current.navigation) 280 else 170
                    button(if (current.navigation) "仅看路线" else "先不开", 30, consentY, 170, 48, 0, current.focus, controlId = R.id.consent_cancel)
                    button(if (current.navigation) "同意并开启街道图" else if (current.avatar) "确认开启数字人" else "确认开启", 220, consentY, 260, 48, 1, current.focus,
                        controlId = R.id.consent_enable)
                }
                is HudScreen.Appearance -> {
                    face(30, 20, 96, 0)
                    place(lens, label("她的样子", 20, ink, true), 148, 20, 462, 30)
                    place(lens, label(if (hud.listening) "当前样子" else "待同步"), 148, 60, 462, 28)
                    place(lens, label("到 iPhone 更换", 18, ink).apply { id = R.id.appearance_phone }, 148, 98, 462, 30)
                    centered("双击返回", 152)
                }
                is HudScreen.Settings -> {
                    centered("设置", 22, 18, ink, bold = true)
                    val pair = enrollment.pairing()
                    val host = java.net.URI(pair?.getString("origin") ?: DEFAULT_GATEWAY).host
                    val rows = listOf("随身" to ambientDisplay(hud, now).text,
                        "字号" to if (enrollment.largeText) "大" else "标准", "连接" to "${if (hud.listening) "已连接" else "未连接"}\n$host",
                        "眼镜编号" to (pair?.getString("device_id")?.replace("-", "")?.chunked(4)?.joinToString(" ") ?: "未配对"),
                        "重新配对" to if (hud.status == "正在断开连接") hud.status else "",
                        "眼镜锁" to if (hud.paymentLock.enabled) "已开启 · 单击锁定" else "请在 iPhone 上设置",
                        "我的声音" to if (hud.voiceEnrollment.ownerEnrolled) "已录入 · 单击重录" else "在 iPhone 上授权录入", "她的样子" to "到 iPhone 更换",
                        "本地唤醒" to if (hud.localWakeEnabled) "已开启 · 仅本机" else "已关闭 · 单击开启",
                        "补充声音" to "可选 · 和依米聊一会儿")
                    val first = (current.focus - 4).coerceAtLeast(0)
                    rows.drop(first).take(5).forEachIndexed { i, (title, value) -> button(title, 30, 74 + i * big(52), 580, big(52), i, current.focus - first, value = value, targetFocus = first + i, controlId = if (first + i == 7) R.id.appearance_open else View.NO_ID) }
                    centered("上下滑动选择 · 单击修改 · 双击返回", 424)
                }
                is HudScreen.Card -> {
                    val shown = card!!
                    val band = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                    fun line(text: String, size: Int = 16, color: Int = ink2, bold: Boolean = false, lines: Int = 1) {
                        val view = label(text, size, color, bold, lines); band.addView(view); if (left) cardText += view
                    }
                    if (choice) {
                        val option = shown.actions[current.option]
                        line("给你挑了… · ${current.option + 1}/${shown.actions.size}")
                        line(option.label, 20, ink, true)
                        line((shown.lines + option.lines.orEmpty()).joinToString(" · "))
                        line("滑动换一家 · 单击${if (hud.ride == null) "或点头" else ""}就这家 · 双击都不要", color = ink3)
                    } else {
                        line(shown.title, color = ink, bold = true)
                        line(shown.lines.joinToString("\n"), 20, ink, true, 2)
                        if (shown.actions.isNotEmpty()) line("单击${shown.actions.single().label} · 双击忽略", color = ink3)
                    }
                    place(lens, band, 78, 18, if (!choice && hud.cards.any { it.progress != null }) 366 else 532, big(114))
                }
                is HudScreen.Move -> {
                    val stale = now - hud.rideAt >= 10000
                    val alert = hud.ride?.optBoolean("hr_alert") == true && !stale
                    val layout = moveLayout!!
                    layout.turnIcon?.let { rect ->
                        place(lens, ImageView(this@MainActivity).apply {
                            setImageResource(turns.getValue(hud.nav!!.getString("maneuver")))
                        }, rect.x, rect.y, rect.width, rect.height)
                    }
                    layout.heartIcon?.let { rect ->
                        place(lens, ImageView(this@MainActivity).apply {
                            setImageResource(R.drawable.ic_heart); imageTintList = ColorStateList.valueOf(if (alert) danger else if (stale) ink3 else ink)
                        }, rect.x, rect.y, rect.width, rect.height)
                    }
                    layout.portrait?.let { rect -> face(rect.x + 4, rect.y + 4, 34, 4) }
                    layout.texts.forEach { item ->
                        val primary = item.role in setOf("speed", "heart", "navigation", "middle", "say", "thinking_status", "overview_totals")
                        val riding = item.role.startsWith("speed") || item.role.startsWith("heart") || item.role.startsWith("middle")
                        val color = if (alert && item.role.startsWith("heart")) danger
                            else if (stale && riding) ink3 else if (primary) ink else ink2
                        val view = moveHudTextView(this@MainActivity, item, enrollment.largeText,
                            if (item.role == "call_status") yimi else color, if (stale) ink3 else ink2)
                        if (item.role == "say") {
                            val age = now - hud.sayAt
                            view.alpha = captionAlpha(age)
                            schedule(if (age < 4000) 4000 - age else 100)
                        }
                        val rect = item.rect
                        place(lens, view, rect.x, rect.y, rect.width, rect.height)
                    }
                }
                is HudScreen.Summary -> {
                    val ride = hud.summary!!
                    centered("骑行完成 · 已存进「健康」", 22, 18, ink, bold = true)
                    fun whole(key: String) = ride.num(key)?.roundToInt()?.toString()
                    listOf(Triple("距离", one(ride.getDouble("distance_m") / 1000), "km"), Triple("时长", clock(ride.getDouble("moving_s")), null),
                        Triple("均速", one(ride.getDouble("avg_kmh")), "km/h"), Triple("最高速度", one(ride.getDouble("max_kmh")), "km/h"),
                        Triple("爬升", whole("elev_gain_m"), "m"), Triple("消耗", whole("kcal"), "千卡"),
                        Triple("平均心率", whole("hr_avg"), null), Triple("最高心率", whole("hr_max"), null)).forEachIndexed { i, (name, value, unit) ->
                        val x = 50 + i % 2 * 286; val y = 70 + i / 2 * 59
                        place(lens, LinearLayout(this@MainActivity).apply {
                            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(2), 0, dp(2), 0)
                            addView(label(name), LinearLayout.LayoutParams(0, -2, 1f)); addView(metric(value ?: "—", unit.takeIf { value != null }, 24, ink))
                        }, x, y, 254, 55)
                        place(lens, View(this@MainActivity).apply { setBackgroundColor(0x38A6AEC0) }, x, y + 55, 254, 1)
                    }
                    card?.let { shown -> say(shown.lines.joinToString(" "), 334, true).also { if (left) cardText += it } }
                    centered("双击返回", 425)
                    schedule(60000 - (now - current.touched))
                }
                else -> Unit
            }
            if (callMode != null && !specialBand && (base == HudScreen.Talking || base is HudScreen.Card)) {
                val modeY = if (card != null) 336 else 20
                val modeX = if (modeY == 20 && hud.avatarPhase == "Playing" && hud.conversation?.mode != "thinking") 194 else 30
                if (activity == null && (modeY == 20 || screen !is HudScreen.Menu)) place(lens, label("$callMode · ${voiceStatus(hud)}", 18, yimi, true).apply {
                    id = R.id.call_conversation_status; contentDescription = text
                }, modeX, modeY, 610 - modeX, big(30))
                if (screen !is HudScreen.Menu) thinkingText?.let { status ->
                    place(lens, android.widget.ScrollView(this@MainActivity).apply {
                        addView(label(status, 16, ink, lines = Int.MAX_VALUE).apply {
                            id = R.id.call_thinking_status; contentDescription = status
                        })
                    }, 30, 374, 580, 80)
                }
            }
            (screen as? HudScreen.Menu)?.let { menu ->
                // ⑪: the main menu's rows are 42 high; six fit above the hint and the list scrolls with the focus.
                val items = hudMenu(hud, menu.modeChoices); val row = if (hud.callId == null) 42 else 46; val first = (menu.focus - 5).coerceAtLeast(0)
                val menuTop = if (moveLayout != null) 168 else 140
                items.drop(first).take(6).forEachIndexed { i, item ->
                    val icon = when (item.action) {
                        "TAP", "MUTE" -> R.drawable.ic_mic; "STOP", "RIDE_STOP", "NAV_STOP" -> R.drawable.ic_stop_circle; "PRIVATE" -> R.drawable.ic_eye
                        "RIDE_START" -> R.drawable.ic_ride; "NAV" -> R.drawable.ic_nav; else -> R.drawable.ic_settings
                    }
                    button(item.label, 270, menuTop + i * (row + 4), 340, row, i, menu.focus - first, icon,
                        if (item.action == "STOP") danger else ink2, targetFocus = first + i, controlId = when (item.action) {
                            "AMBIENT" -> R.id.ambient_toggle; "AMBIENT_RETRY" -> R.id.ambient_retry; "PRIVATE" -> R.id.privacy_toggle; "RECORD" -> R.id.record_toggle
                            "TAP" -> R.id.call_open; "AVATAR" -> R.id.avatar_toggle; "CAMERA" -> R.id.camera_toggle
                            "MUTE" -> R.id.call_mute; "STOP" -> R.id.call_hangup
                            "MODE" -> R.id.call_conversation_menu; "MODE_CHAT" -> R.id.call_mode_chat; "MODE_THINKING" -> R.id.call_mode_thinking
                            "THINK_RETRY" -> R.id.call_thinking_retry; "THINK_CHAT" -> R.id.call_switch_to_chat; else -> View.NO_ID
                        })
                    controls.last().apply { isEnabled = item.enabled; alpha = if (item.enabled) 1f else .5f }
                }
                place(lens, label("单击确认 · 双击收起", color = ink3).apply { gravity = Gravity.END }, 410, menuTop + 2 + minOf(items.size, 6) * (row + 4), 200, big(28))
                schedule(5000 - (now - menu.touched))
            }
            if (left) targets += controls.ifEmpty { listOf(lens) }
        }
        val holder = FocusHolder(true)
        holder.addFocusTarget(*targets.map { target -> FocusInfo(target, { action ->
            if (action is TempleAction.Click) dispatch(HudGesture.Click)
            else if (action is TempleAction.DoubleClick) dispatch(HudGesture.DoubleClick)
        }, {}) }.toTypedArray())
        tracker = FixPosFocusTracker(holder, false, false, 0)
        holder.currentFocus(targets[selected]); tracker!!.focusObj.reqFocus()
        val painting = screen
        mBindingPair.left.lens.doOnPreDraw {
            if (screen == painting) {
                if (companionViews.size == 2 && companionViews.all { it.textFits() } && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
                    companion?.cards?.forEach { shown -> shown.ack?.let { ack ->
                        val identity = canonicalJson(ack)
                        if (companionRendered.add(identity)) { send("RENDERED", shown.id, ack.toString())
                            while (companionRendered.size > 64) companionRendered.remove(companionRendered.first()) }
                    } }
                if (presentedCard?.copy(ack = null) != card?.copy(ack = null)) head.reset()
                presented = painting; presentedCard = card; presentedMenu = hudMenu(hud, (screen as? HudScreen.Menu)?.modeChoices == true); presentedCallId = hud.callId
                if (card?.actions?.isEmpty() == true && noticeId != card.id) {
                    noticeId = card.id; noticeSince = monotonicMillis(); schedule(3000)
                }
                // Receipts cover packet text only after it fits inside the visible optical band.
                if (card?.ack != null && rendered != canonicalJson(card.ack) && cardText.all { text ->
                    val parent = text.parent as LinearLayout
                    text.bottom <= parent.height && text.layout != null && text.layout.height <= text.height && text.layout.lineCount <= text.maxLines &&
                        (0 until text.layout.lineCount).all { text.layout.getEllipsisCount(it) == 0 }
                }) { rendered = canonicalJson(card.ack); send("RENDERED", card.id, card.ack.toString()) }
            }
        }
        hud.cards.filter { it.expiresAt != Long.MAX_VALUE }.minOfOrNull { it.expiresAt }?.let { schedule(it - now) }
        hud.captions.maxOfOrNull { it.at + 5000 }?.takeIf { it > now }?.let { schedule(it - now) }
        hud.payment?.until?.takeIf { it > now && it != Long.MAX_VALUE }?.let { schedule(it - now) }
        listOfNotNull(hud.paymentLock.bannerUntil.takeIf { it > now }, hud.paymentLock.approvalUntil?.takeIf { it > now },
            hud.paymentLock.connectionWaitUntil?.takeIf { it > now }).minOrNull()?.let { schedule(it - now) }
        listOf(hud.moveAt + 10000, hud.rideAt + 10000, hud.rideAt + 60000, hud.sayAt + 4000).filter { it > now }.minOrNull()?.let { schedule(it - now) }
        if (card != null && card.actions.isEmpty() && noticeId == card.id) {
            if (now - noticeSince >= 3000) send("DISMISS", card.id) else schedule(3000 - (now - noticeSince))
        }
        if (base == HudScreen.Idle) {
            if (now < hintUntil) schedule(hintUntil - now)
            if (now - lastContent < 10000) schedule(10000 - (now - lastContent))
        }
    }
    private fun big(value: Int) = if (enrollment.largeText) value * 6 / 5 else value
    // Riding numbers: weight 800 with tabular digits; the optional unit is 16sp, weight 600, ink2.
    private fun metric(value: String, unit: String?, size: Int, color: Int, gap: String = "\u2009") = label("", size, color).apply {
        typeface = Typeface.create(Typeface.DEFAULT, 800, false); fontFeatureSettings = "tnum"
        text = SpannableStringBuilder(value).apply { if (unit != null) inSpans(RelativeSizeSpan(16f / size), ForegroundColorSpan(ink2),
            TypefaceSpan(Typeface.create(Typeface.DEFAULT, 600, false))) { append(gap + unit) } }
    }
    private fun column(gravity: Int, gap: Int, vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; this.gravity = gravity
        views.forEachIndexed { i, view -> addView(view, LinearLayout.LayoutParams(-2, -2).apply { if (i > 0) topMargin = dp(gap) }) }
    }
    private fun one(value: Double) = "%.1f".format(value)
    private fun clock(seconds: Double) = seconds.toLong().let { "%d:%02d:%02d".format(it / 3600, it / 60 % 60, it % 60) }
    private fun JSONObject.num(key: String) = if (has(key)) getDouble(key) else null
    private val turns = mapOf("left" to R.drawable.ic_turn_left, "right" to R.drawable.ic_turn_right,
        "slight_left" to R.drawable.ic_turn_slight_left, "slight_right" to R.drawable.ic_turn_slight_right,
        "sharp_left" to R.drawable.ic_turn_sharp_left, "sharp_right" to R.drawable.ic_turn_sharp_right,
        "straight" to R.drawable.ic_turn_straight, "uturn" to R.drawable.ic_turn_uturn,
        "arrive" to R.drawable.ic_turn_arrive, "depart" to R.drawable.ic_turn_depart)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun label(text: String, size: Int = 16, color: Int = ink2, bold: Boolean = false, lines: Int = 1) = TextView(this).apply {
        this.text = text; textSize = size * if (enrollment.largeText) 1.2f else 1f; setTextColor(color)
        typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT; includeFontPadding = false
        maxLines = lines; ellipsize = TextUtils.TruncateAt.END
    }
    private fun place(parent: FrameLayout, view: View, x: Int, y: Int, width: Int, height: Int) {
        parent.addView(view, FrameLayout.LayoutParams(dp(width), dp(height)).apply { leftMargin = dp(x); topMargin = dp(y) })
    }
    override fun onSensorChanged(event: SensorEvent) {
        head.sample(event.timestamp, event.values[0], event.values[1], event.values[2], choice = true)?.let {
            if (it == "nod") dispatch(HudGesture.Nod) else if (it == "shake") dispatch(HudGesture.Shake)
        }
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
