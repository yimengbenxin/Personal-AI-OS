package com.personalaios.glasses

import org.json.JSONObject

sealed interface HudScreen {
    data class Pairing(val focus: Int = 0) : HudScreen
    object Scanning : HudScreen
    data class ScanFailed(val reason: String) : HudScreen
    data class Paired(val until: Long) : HudScreen
    data class Notice(val text: String, val until: Long) : HudScreen
    object Idle : HudScreen
    object Talking : HudScreen
    data class Consent(val under: HudScreen, val avatar: Boolean = false, val focus: Int = 0, val callId: String? = null, val navigation: Boolean = false) : HudScreen
    data class Appearance(val under: HudScreen) : HudScreen
    object Locked : HudScreen
    object Payment : HudScreen
    data class VoiceEnrolment(val under: HudScreen, val finish: Boolean = false) : HudScreen
    /** The optional ordinary voice supplement: a short phone-approved chat with 依米. */
    data class VoiceSupplement(val under: HudScreen) : HudScreen
    data class Card(val id: String, val option: Int = 0) : HudScreen
    data class Menu(val under: HudScreen, val focus: Int = 0, val touched: Long, val modeChoices: Boolean = false) : HudScreen
    data class Settings(val under: HudScreen, val focus: Int = 0) : HudScreen
    /** Riding (page 1 is the second data page) or walking navigation. */
    data class Move(val page: Int = 0) : HudScreen
    data class Summary(val touched: Long) : HudScreen
    /** Alipay's glasses scan is in front of 依米. */
    object Paying : HudScreen
}

/** Pay and Resume are the pay_open request and the activity's return to the foreground. */
enum class HudGesture { Click, DoubleClick, Forward, Backward, Up, Down, LongClick, Nod, Shake, Pay, Resume }
data class HudTransition(val screen: HudScreen, val action: String? = null, val cardId: String? = null, val actionId: String? = null)
data class HudMenuItem(val label: String, val action: String, val enabled: Boolean = true)

fun hudMenu(state: HudState, modeChoices: Boolean = false): List<HudMenuItem> = if (state.callId != null && modeChoices && state.conversation != null) listOf(
    HudMenuItem("聊天" + if (state.conversation.mode == "chat") "　已选" else "", "MODE_CHAT", state.conversationPending == null),
    HudMenuItem("思考" + if (state.conversation.mode == "thinking") "　已选" else "", "MODE_THINKING", state.conversationPending == null)
) else if (state.callId != null) listOfNotNull(
    if (state.conversation?.mode != "thinking") HudMenuItem("数字人　${avatarLabel(state)}", "AVATAR") else null,
    HudMenuItem("前方镜头　${cameraLabel(state)}", "CAMERA"),
    HudMenuItem(if (state.micMuted) "取消静音" else "静音", "MUTE"), HudMenuItem("挂断", "STOP"),
    conversationLabel(state)?.let { HudMenuItem("通话模式　$it", "MODE") },
    state.conversation?.takeIf { "retry" in it.actions }?.let { HudMenuItem("重试", "THINK_RETRY") },
    state.conversation?.takeIf { "switch_to_chat" in it.actions }?.let { HudMenuItem("切回聊天", "THINK_CHAT", state.conversationPending == null) }
) else listOf(
    HudMenuItem("随身　${ambientDisplay(state).let { if (it.confirmed) { if (state.ambient) "开" else "关" } else it.text }}", "AMBIENT"),
    HudMenuItem(if (state.capture.privacyPending) "隐私暂停　等待确认" else if (state.capture.privatePaused) "结束隐私暂停" else "隐私暂停", "PRIVATE"),
    HudMenuItem(if (state.recording) "停止录音" else "开始录音", "RECORD"), HudMenuItem("通话", "TAP"),
    if (state.ride != null) HudMenuItem("结束骑行", "RIDE_STOP") else HudMenuItem("骑行", "RIDE_START"),
    if (state.nav != null) HudMenuItem("结束导航", "NAV_STOP") else HudMenuItem("导航", "NAV"), HudMenuItem("设置", "SETTINGS")) +
    state.cards.lastOrNull { it.progress != null }?.let { listOf(HudMenuItem("停下${it.title}", "STOP")) }.orEmpty() +
    (if (ambientDisplay(state).retry) listOf(HudMenuItem("重试随身", "AMBIENT_RETRY")) else emptyList())

fun avatarLabel(state: HudState): String = when (state.avatarPhase) {
    "Playing" -> "开"
    "Waiting", "Joining" -> "等待画面"
    "Failed" -> "失败 · 重试"
    else -> "关"
}
fun cameraLabel(state: HudState): String = when {
    state.capture.error != null -> "失败 · 重试"
    !state.capture.callCameraRequested -> if (state.capture.callCameraPublished || state.capture.closing) "等待关闭" else "关"
    state.capture.callCameraPublished -> "开"
    else -> "等待画面"
}

/** Gateway move_hud / move_say / ride_summary received at [now]; a summary ends the riding layout. */
fun HudState.move(message: JSONObject, now: Long, serverNow: Long = now): HudState = when (message.getString("operation")) {
    "nav_route" -> NavigationRoute.fromWire(message).let { route -> copy(navigationRoute = route,
        nav = nav ?: JSONObject(),
        routeOverviewUntil = if (route.overview?.show == true) {
            if (now - rideAt in 0..5000 && ride?.optDouble("speed_kmh", 0.0)?.let { it > 1.0 } == true ||
                navigationMoving && navigationFix?.let { serverNow - it.sampleTime in 0..5000 } == true) 0 else now + 2000
        } else routeOverviewUntil) }
    "move_hud" -> message.getString("kind").let { kind ->
        val fix = if (kind == "ride" || !message.has("nav") || !message.has("position")) null else NavigationFix.fromWire(message)
        val moved = message.optJSONObject("ride")?.optDouble("speed_kmh", 0.0)?.let { it > 1.0 } == true ||
            fix?.let { next -> navigationFix?.let { previous -> next.sampleTime > previous.sampleTime && serverNow - next.sampleTime in 0..10000 &&
                NavMetric.distance(previous.position, next.position) / ((next.sampleTime-previous.sampleTime)/1000.0) > 0.5 } } == true
        copy(ride = if (kind == "walk_nav") null else message.optJSONObject("ride") ?: ride ?: JSONObject(),
        nav = if (kind == "ride") null else message.optJSONObject("nav"), moveAt = now, rideAt = if (message.has("ride")) now else rideAt,
        navigationFix = fix, navigationMoving = moved, routeOverviewUntil = if (moved || kind == "ride") 0 else routeOverviewUntil) }
    "move_say" -> copy(say = message.getString("text"), sayAt = now)
    else -> copy(summary = message, summaryAt = now, ride = null, nav = null, navigationFix = null, navigationMoving = false, routeOverviewUntil = 0)
}

/** Captions: the last two lines until 4 s after the latest, then a 1 s fade ([captionAlpha]). */
fun captionWindow(captions: List<HudCaption>, now: Long) =
    if (captions.isEmpty() || now - captions.maxOf { it.at } >= 5000) emptyList() else captions.takeLast(2)
fun captionAlpha(age: Long) = ((5000 - age) / 1000f).coerceIn(0f, 1f)

/** The HUD at [now]: live cards; old ride metrics become pending after 60 s; old navigation waits for a fresh fix; 依米's line for 4 s.
 *  During movement, only cards that interrupt show; message and notice cards wait. */
fun visibleHud(state: HudState, now: Long, serverNow: Long = now): HudState {
    val masked = state.paymentLock.locked || now < state.paymentLock.bannerUntil
    val ride = state.ride?.let { if (now - state.rideAt < 60000) it else JSONObject() }
    val navigationStale = state.navigationFix == null || now - state.moveAt >= 10000 ||
        state.navigationFix?.let { serverNow - it.sampleTime >= 10000 } == true
    val nav = state.nav?.let { if (navigationStale) JSONObject() else it }
    val moving = ride != null || nav != null
    val captions = if (masked) emptyList() else captionWindow(state.captions, now)
    val caption = captions.lastOrNull { !it.mine && now - it.at < 5000 }?.takeIf { moving }
    val say = state.say?.takeIf { now - state.sayAt < 4000 }
    val useCaption = caption != null && (say == null || caption.at > state.sayAt)
    return state.copy(ride = ride, nav = nav, captions = captions,
        routeOverviewUntil = state.routeOverviewUntil.takeIf { it > now } ?: 0,
        navigationFix = state.navigationFix.takeUnless { navigationStale },
        payment = state.payment?.takeIf { !masked && it.until > now },
        conversation = state.conversation.takeUnless { masked },
        conversationError = state.conversationError.takeUnless { masked },
        say = if (useCaption) caption!!.text else say,
        sayAt = if (useCaption) caption!!.at else state.sayAt,
        cards = state.cards.filter { !it.companion && !masked && it.expiresAt > now && (!moving || it.progress != null || interrupts(it)) })
}
// Choices, call offers and high-priority cards such as the care check-in never wait.
private fun interrupts(card: HudCard) = card.priority > 1 || card.actions.size >= 2

fun settleHud(screen: HudScreen, now: Long): HudScreen = when (screen) {
    is HudScreen.Menu -> if (now - screen.touched >= 5000) screen.under else screen
    is HudScreen.Paired -> if (now >= screen.until) HudScreen.Idle else screen
    is HudScreen.Notice -> if (now >= screen.until) HudScreen.Idle else screen
    is HudScreen.Summary -> if (now - screen.touched >= 60000) HudScreen.Idle else screen
    else -> screen
}

private fun resting(state: HudState, old: HudScreen? = null): HudScreen = when {
    !state.paired -> HudScreen.Pairing()
    state.ride != null || state.nav != null -> old as? HudScreen.Move ?: HudScreen.Move()
    state.callId != null -> HudScreen.Talking
    else -> HudScreen.Idle
}

fun reconcileHud(screen: HudScreen, state: HudState, newCard: Boolean = false): HudScreen {
    if (state.paired && state.paymentLock.locked && screen != HudScreen.Paying) return when {
        state.ride != null || state.nav != null -> screen as? HudScreen.Move ?: HudScreen.Move()
        state.summary != null && screen is HudScreen.Summary -> screen
        else -> HudScreen.Locked
    }
    if (state.payment != null && screen !is HudScreen.Settings && screen !is HudScreen.VoiceEnrolment && screen !is HudScreen.VoiceSupplement && screen != HudScreen.Paying) return HudScreen.Payment
    val cards = state.cards.filter { it.progress == null }
    fun content(old: HudScreen): HudScreen {
        val selected = if (newCard) cards.lastOrNull() else (old as? HudScreen.Card)?.let { oldCard ->
            cards.firstOrNull { it.id == oldCard.id }
        } ?: cards.lastOrNull()
        return selected?.let {
            HudScreen.Card(it.id, (old as? HudScreen.Card)?.takeIf { card -> card.id == it.id }?.option
                ?.coerceAtMost((it.actions.size - 1).coerceAtLeast(0)) ?: 0)
        } ?: resting(state, old)
    }
    return when (screen) {
        HudScreen.Scanning, is HudScreen.ScanFailed, is HudScreen.Paired, is HudScreen.Notice, HudScreen.Paying -> screen
        is HudScreen.Summary -> cards.lastOrNull(::interrupts)?.let { HudScreen.Card(it.id) } ?: screen
        is HudScreen.Settings -> if (!state.paired && screen.under !is HudScreen.Pairing) resting(state)
            else screen.copy(under = if (state.paired) content(screen.under) else HudScreen.Pairing())
        is HudScreen.Consent -> if (!state.paired || screen.avatar && (state.callId != screen.callId || state.conversation?.mode == "thinking")) resting(state) else screen
        is HudScreen.Appearance -> if (state.paired) screen else resting(state)
        is HudScreen.VoiceEnrolment -> if (state.paired) screen.copy(finish = screen.finish && state.voiceEnrollment.canFinish) else resting(state)
        is HudScreen.VoiceSupplement -> if (state.paired) screen else resting(state)
        is HudScreen.Menu -> if (!state.paired) resting(state) else screen.copy(under = content(screen.under),
            focus = screen.focus.coerceAtMost(hudMenu(state, screen.modeChoices).lastIndex),
            modeChoices = screen.modeChoices && state.callId != null && state.conversation != null)
        else -> if (state.paired) content(screen) else if (screen is HudScreen.Pairing) screen else resting(state)
    }
}

fun reduceHud(screen: HudScreen, gesture: HudGesture, state: HudState, now: Long): HudTransition {
    if (gesture == HudGesture.LongClick) return HudTransition(screen)
    if (gesture == HudGesture.Pay) return HudTransition(HudScreen.Paying, "PAY")
    if (gesture == HudGesture.Resume) return if (screen == HudScreen.Paying) HudTransition(resting(state), "PAY_CLOSED") else HudTransition(screen)
    if (screen == HudScreen.Payment) return HudTransition(screen)
    if (state.paired && state.paymentLock.locked) return when (gesture) {
        HudGesture.Click -> HudTransition(HudScreen.Locked, "UNLOCK")
        HudGesture.DoubleClick -> HudTransition(HudScreen.Locked, if (state.callId == null) "FINISH" else "STOP")
        else -> HudTransition(HudScreen.Locked)
    }
    val delta = when (gesture) {
        HudGesture.Forward, HudGesture.Down -> 1
        HudGesture.Backward, HudGesture.Up -> -1
        else -> 0
    }
    if (gesture == HudGesture.DoubleClick) return when (screen) {
        HudScreen.Scanning -> HudTransition(resting(state), "CANCEL_SCAN")
        is HudScreen.Menu -> if (screen.modeChoices) HudTransition(screen.copy(modeChoices = false, focus = 0, touched = now)) else HudTransition(screen.under)
        is HudScreen.Settings -> HudTransition(screen.under)
        is HudScreen.Consent -> HudTransition(screen.under, if (screen.navigation) "MAP_DECLINE" else if (screen.avatar) null else "AMBIENT_CANCEL")
        is HudScreen.Appearance -> HudTransition(screen.under)
        is HudScreen.VoiceEnrolment -> HudTransition(screen.under, "VOICE_CANCEL")
        is HudScreen.VoiceSupplement -> HudTransition(screen.under, "SUPPLEMENT_CANCEL")
        is HudScreen.Card -> HudTransition(resting(state), "DISMISS", screen.id)
        HudScreen.Talking -> HudTransition(screen, "STOP")
        // Riding or navigating, double click never ends the ride or the route: it asks through the menu (结束骑行 / 结束导航).
        is HudScreen.Move -> if (state.callId != null) HudTransition(screen, "STOP") else HudTransition(HudScreen.Menu(screen, touched = now))
        is HudScreen.ScanFailed, is HudScreen.Paired, is HudScreen.Notice, is HudScreen.Summary, HudScreen.Paying -> HudTransition(resting(state))
        else -> HudTransition(screen, "FINISH")
    }
    return when (screen) {
        is HudScreen.Pairing -> when {
            delta != 0 -> HudTransition(screen.copy(focus = Math.floorMod(screen.focus + delta, 2)))
            gesture != HudGesture.Click -> HudTransition(screen)
            screen.focus == 0 -> HudTransition(HudScreen.Scanning, "SCAN")
            else -> HudTransition(HudScreen.Settings(screen))
        }
        HudScreen.Scanning -> if (gesture == HudGesture.Click) HudTransition(resting(state), "CANCEL_SCAN") else HudTransition(screen)
        is HudScreen.ScanFailed -> if (gesture == HudGesture.Click) HudTransition(HudScreen.Scanning, "SCAN") else HudTransition(screen)
        is HudScreen.Paired, is HudScreen.Notice, HudScreen.Paying, HudScreen.Locked, HudScreen.Payment -> HudTransition(screen)
        is HudScreen.VoiceEnrolment -> when {
            delta != 0 && state.voiceEnrollment.canFinish -> HudTransition(screen.copy(finish = !screen.finish))
            gesture == HudGesture.Click -> when (state.voiceEnrollment.phase) {
                VoiceEnrollmentPhase.Enrolled -> HudTransition(screen.under, "VOICE_CANCEL")
                VoiceEnrollmentPhase.Expired, VoiceEnrollmentPhase.Failed -> HudTransition(screen, "VOICE_ENROL")
                else -> HudTransition(screen, if (screen.finish) "VOICE_FINISH" else "VOICE_TAP")
            }
            else -> HudTransition(screen)
        }
        is HudScreen.VoiceSupplement -> if (gesture != HudGesture.Click) HudTransition(screen) else when (state.voiceSupplement.phase) {
            VoiceSupplementPhase.Idle, VoiceSupplementPhase.Failed -> HudTransition(screen, "SUPPLEMENT_REQUEST")
            VoiceSupplementPhase.Saved -> HudTransition(screen.under, "SUPPLEMENT_CANCEL")
            else -> HudTransition(screen, "SUPPLEMENT_TAP")
        }
        is HudScreen.Consent -> when {
            delta != 0 -> HudTransition(screen.copy(focus = 1 - screen.focus))
            gesture == HudGesture.Click -> HudTransition(screen.under,
                if (screen.focus == 0) { if (screen.navigation) "MAP_DECLINE" else if (screen.avatar) null else "AMBIENT_CANCEL" }
                else if (screen.navigation) "MAP_AGREE" else if (screen.avatar) "AVATAR_ON" else "AMBIENT_CONFIRM")
            else -> HudTransition(screen)
        }
        is HudScreen.Appearance -> HudTransition(screen)
        is HudScreen.Summary -> HudTransition(screen.copy(touched = now))
        is HudScreen.Move -> when {
            gesture in setOf(HudGesture.Forward, HudGesture.Backward) && state.nav != null &&
                state.navigationRoute?.overview?.alternatives?.isNotEmpty() == true -> HudTransition(screen, "NAV_SWITCH")
            delta != 0 && state.ride != null -> HudTransition(screen.copy(page = 1 - screen.page))
            delta != 0 || gesture == HudGesture.Click && state.callId != null -> HudTransition(HudScreen.Menu(screen, touched = now))
            gesture == HudGesture.Click -> HudTransition(screen, "TAP")
            else -> HudTransition(screen)
        }
        HudScreen.Idle, HudScreen.Talking -> when {
            delta != 0 || screen == HudScreen.Talking && gesture == HudGesture.Click -> HudTransition(HudScreen.Menu(screen, touched = now))
            gesture == HudGesture.Click -> HudTransition(screen, "TAP")
            else -> HudTransition(screen)
        }
        is HudScreen.Menu -> when {
            delta != 0 -> HudTransition(screen.copy(focus = Math.floorMod(screen.focus + delta, hudMenu(state, screen.modeChoices).size), touched = now))
            gesture != HudGesture.Click -> HudTransition(screen)
            else -> hudMenu(state, screen.modeChoices)[screen.focus].let {
                if (!it.enabled) HudTransition(screen)
                else if (it.action == "MODE") HudTransition(screen.copy(modeChoices = true, focus = 0, touched = now))
                else if (it.action == "SETTINGS") HudTransition(HudScreen.Settings(screen.under))
                else if (it.action == "AMBIENT" && !state.ambient) HudTransition(HudScreen.Consent(screen.under), "AMBIENT_ON")
                else if (it.action == "AVATAR" && state.avatarPhase in setOf("Off", "Failed")) HudTransition(HudScreen.Consent(screen.under, avatar = true, callId = state.callId))
                else HudTransition(screen.under, when (it.action) {
                    "AMBIENT" -> "AMBIENT_OFF"
                    "AVATAR" -> "AVATAR_OFF"
                    else -> it.action
                })
            }
        }
        is HudScreen.Settings -> when {
            delta != 0 -> HudTransition(screen.copy(focus = Math.floorMod(screen.focus + delta, 10)))
            gesture != HudGesture.Click -> HudTransition(screen)
            screen.focus == 0 && state.paired -> HudTransition(HudScreen.Menu(screen, touched = now))
            screen.focus == 1 -> HudTransition(screen, "TEXT_SIZE")
            screen.focus == 4 -> if (state.paired) HudTransition(screen, "REPAIR") else HudTransition(HudScreen.Pairing())
            screen.focus == 5 && state.paymentLock.enabled -> HudTransition(HudScreen.Locked, "LOCK")
            screen.focus == 7 && state.paired -> HudTransition(HudScreen.Appearance(screen))
            screen.focus == 8 && state.paired -> HudTransition(screen, "WAKE")
            screen.focus == 6 && state.paired -> HudTransition(HudScreen.VoiceEnrolment(screen), "VOICE_ENROL")
            screen.focus == 9 && state.paired -> HudTransition(HudScreen.VoiceSupplement(screen), "SUPPLEMENT_REQUEST")
            else -> HudTransition(screen)
        }
        is HudScreen.Card -> {
            val card = state.cards.first { it.id == screen.id }
            val choice = card.actions.size >= 2
            when {
                choice && delta != 0 -> HudTransition(screen.copy(option = Math.floorMod(screen.option + delta, card.actions.size)))
                !choice && delta != 0 -> state.cards.filter { it.progress == null }.let { cards ->
                    HudTransition(HudScreen.Card(cards[Math.floorMod(cards.indexOf(card) + delta, cards.size)].id))
                }
                choice && gesture == HudGesture.Shake -> HudTransition(resting(state), "DISMISS", card.id)
                (gesture == HudGesture.Click || choice && gesture == HudGesture.Nod) && card.actions.isNotEmpty() ->
                    HudTransition(resting(state), "APPROVE", card.id, card.actions[screen.option].id)
                else -> HudTransition(screen)
            }
        }
    }
}
