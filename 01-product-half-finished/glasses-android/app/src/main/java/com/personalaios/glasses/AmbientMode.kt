package com.personalaios.glasses

import kotlinx.coroutines.flow.MutableStateFlow

// 随身模式 (Enrollment.ambientMode, the owner's own glasses switch, default off). Off, the glasses record nothing on
// their own: local wake and first-person memory are off; publication needs an owner action.
// Each text is one constant; the switch mockup changes only these lines.
internal const val AMBIENT_ON_STATUS = "随身开"
internal const val AMBIENT_OFF_STATUS = "随身关"
internal const val AMBIENT_ON_NOTICE = "随身开"
internal const val AMBIENT_OFF_NOTICE = "随身关"
fun idleStatus(state: HudState) = if (state.ambient) AMBIENT_ON_STATUS else AMBIENT_OFF_STATUS

/** Capture-backed local readiness is independent of the gateway connection indicator. */
fun localWakeStatus(state: HudState): String = when {
    state.status == "已停止" || state.status == "正在断开连接" -> state.status
    !state.paired -> "未配对"
    !state.localWakeEnabled -> "唤醒已关"
    !state.ambient -> "随身关"
    state.phoneAudio && state.callId == null -> "手机通话中"
    state.capture.worn == false -> "没戴"
    state.capture.worn == null -> "佩戴状态未知"
    else -> when (state.localWake) {
        LocalWakeState.Off -> "唤醒已停"
        LocalWakeState.Loading -> "唤醒加载中"
        LocalWakeState.WaitingForAudio -> "等待麦克风"
        LocalWakeState.LocalReady -> "可唤醒"
        LocalWakeState.Unavailable -> "唤醒不可用"
    }
}

enum class AmbientStatus(val text: String) {
    Off("随身关"), Confirmation("等待确认"), Disconnected("未连接"), Error("错误"),
    Waiting("等待确认"), Private("隐私暂停"), NotWorn("没戴"), Active("随身开")
}

/** Acquisition eligibility, independent of display receipts to avoid waiting for its own microphone. */
fun ambientStatus(state: HudState): AmbientStatus = when {
    state.ambientConfirmation -> AmbientStatus.Confirmation
    !state.ambient -> AmbientStatus.Off
    !state.listening -> AmbientStatus.Disconnected
    state.capture.error != null -> AmbientStatus.Error
    state.capture.privacyPending || !state.capture.policyCurrent -> AmbientStatus.Waiting
    state.capture.privatePaused -> AmbientStatus.Private
    state.capture.worn == false -> AmbientStatus.NotWorn
    state.capture.worn == null -> AmbientStatus.Waiting
    else -> AmbientStatus.Active
}

data class AmbientDisplay(val text: String, val retry: Boolean = false, val confirmed: Boolean = false)
internal const val AMBIENT_APPLY_TIMEOUT_MS = 10_000L

/** Intent is durable; this readout reports only capture policy and microphone application receipts. */
fun ambientDisplay(state: HudState, now: Long = monotonicMillis()): AmbientDisplay {
    if (state.ambientConfirmation) return AmbientDisplay("开启随身？请确认")
    val intent = if (state.ambient) "开" else "关"
    if (!state.paired) return AmbientDisplay("未连接 · 上次随身$intent · 到手机处理")
    val error = state.ambientError ?: state.capture.error?.takeIf { state.listening }
    if (error != null) {
        val phone = error.contains("permission", true) || error.contains("SecurityException") || error.contains("权限")
        return AmbientDisplay("错误 · $error · ${if (phone) "到手机处理" else "重试"}", retry = !phone)
    }
    if (!state.listening) return AmbientDisplay("未连接 · 上次随身$intent")
    val pending = !state.capture.policyCurrent || state.capture.privacyPending ||
        (!state.ambient && (!state.capture.paused || state.capture.closing)) ||
        (state.ambient && !state.capture.privatePaused &&
            (state.capture.worn == null ||
                (state.callId == null || state.capture.callCameraRequested) &&
                (state.capture.paused || state.capture.status !in setOf("ready", "capturing", "call")))) ||
        state.microphoneApplied != microphone(state, now)
    if (pending) return if (state.ambientRequestedAt > 0 && now - state.ambientRequestedAt >= AMBIENT_APPLY_TIMEOUT_MS)
        AmbientDisplay("确认超时 · 重试", retry = true) else AmbientDisplay("等待确认")
    if (state.capture.privatePaused) return AmbientDisplay("隐私暂停", confirmed = true)
    if (state.capture.worn == false) return AmbientDisplay(if (state.ambient) "没戴 · 随身仍在记录" else "没戴 · 随身关", confirmed = true)
    return AmbientDisplay("随身$intent", confirmed = true)
}

/** Confirmation is transient; only confirmed owner intent is stored across service/process recreation. */
internal class AmbientSwitch(private val enrollment: Enrollment, private val hud: MutableStateFlow<HudState>,
    private val apply: (Boolean) -> Unit) {
    fun request(on: Boolean) {
        if (!on) commit(false)
        else if (!hud.value.ambient) hud.value = hud.value.copy(ambientConfirmation = true)
    }
    fun confirm() { if (hud.value.ambientConfirmation) commit(true) }
    fun cancel() { hud.value = hud.value.copy(ambientConfirmation = false) }
    fun retry() { commit(hud.value.ambient) }
    private fun commit(on: Boolean) {
        enrollment.ambientMode = on
        val idle = hud.value.status == idleStatus(hud.value)
        hud.value = hud.value.copy(ambient = on, ambientConfirmation = false,
            ambientRequestedAt = monotonicMillis(), microphoneApplied = null, ambientError = null).let {
            if (idle) it.copy(status = idleStatus(it)) else it
        }
        apply(on)
    }
}

/** Off unpublishes: the SDK's own off only mutes, and a muted track keeps the audio device recording. Muted is the in-call mute. */
enum class Microphone { Off, Muted, On }

// The server cuts a voiceprint sample from the published microphone between voiceprint_open and its measured result.
internal val enrolmentWindow = setOf(VoiceEnrollmentPhase.Opening, VoiceEnrollmentPhase.Recording, VoiceEnrollmentPhase.Measuring)

/** What the one published microphone should be now. With 随身模式 off only an owner action needs it: a talk or call he
 *  opened or answered (tap, wake-free), 录入我的声音's reading window, or a payment he started that asks for 「付吧」. */
fun microphone(state: HudState, now: Long = monotonicMillis(), wakeCallId: String? = null): Microphone = when {
    state.phoneAudio && (state.callId == null || state.callClosing) -> Microphone.Off
    state.callClosing -> if (state.recording || ambientStatus(state) in setOf(AmbientStatus.Active, AmbientStatus.NotWorn)) Microphone.On else Microphone.Off
    wakeCallId != null && state.callId == wakeCallId && state.busy && !state.ambient && !state.recording -> Microphone.Off
    state.callId != null && state.micMuted -> Microphone.Muted
    state.recording -> Microphone.On
    state.callId != null || state.voiceEnrollment.phase in enrolmentWindow ||
        state.payment?.capturesVoice(now) == true -> Microphone.On
    ambientStatus(state) in setOf(AmbientStatus.Active, AmbientStatus.NotWorn) -> Microphone.On
    else -> Microphone.Off
}
