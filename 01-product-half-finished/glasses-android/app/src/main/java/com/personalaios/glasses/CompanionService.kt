package com.personalaios.glasses

import android.app.*
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import livekit.org.webrtc.AudioTrackSink
import java.nio.ByteBuffer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.UUID

class CompanionService : Service() {
    companion object {
        val state = MutableStateFlow(HudState())
        internal val avatarStream = AvatarStream()
        internal val avatarHosts = MutableStateFlow<List<android.widget.FrameLayout>?>(null)
        /** MainActivity's Paying screen: Alipay's glasses scan is in front. */
        @Volatile var paying = false
        // Preserve the cycle across Service recreation within this app process.
        private val unlock = UnlockLease()
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val link = ConnectionLoop()
    private lateinit var enrollment: Enrollment
    private lateinit var gateway: GatewayClient
    private var requestedPhoto: String? = null
    private lateinit var capture: FirstPersonCapture
    private val appearance by lazy { AppearanceState(this, scope) { state.value = state.value.copy(avatar = it) } }
    private val ambientSwitch by lazy { AmbientSwitch(enrollment, state, ::setAmbient) }
    private val avatar by lazy { GlassesAvatar(this, scope, avatarStream, avatarHosts, ::queue) }
    private val playback by lazy { VoicePlayback(this, scope, { inbox?.replies }, ::queue, ::failedRequest) { packet, playing ->
        val chunk = packet.getJSONObject("chunk")
        inbox?.companionReply?.playback(packet.getString("processed_event_id"), chunk.getLong("reply_epoch"), playing,
            !playing && chunk.getBoolean("final"), monotonicMillis()); snapshot()
    } }
    private var session: LiveSession? = null
    private var inbox: HudCards? = null
    private var wake: WakeWord? = null
    private val phoneAudio by lazy { PhoneAudio(this) { active ->
        Log.i("Yimi", "phone_audio active=$active")
        state.value = state.value.copy(phoneAudio = active)
    } }
    private val wakeAudioSignal = Channel<Unit>(Channel.CONFLATED)
    private var wakeSender: Job? = null
    @Volatile private var pendingWakeId: String? = null
    private val wakeAudio = WakePcm({ wakeAudioSignal.trySend(Unit) }, { id ->
        scope.launch { failWakeAudio(id, "唤醒音频缓冲已满，请重试") }
    })
    private val localAudioTap = object : AudioTrackSink {
        override fun onData(audio: ByteBuffer, bits: Int, rate: Int, channels: Int, frames: Int, capturedMs: Long) {
            val samples = wakeCaptureSamples(audio, state.value.micMuted)
            wakeAudio.onData(samples, bits, rate, channels, frames, capturedMs)
            wake?.onData(samples, bits, rate, channels, frames, capturedMs)
        }
    }
    private var driver: Job? = null
    private var operation: Job? = null
    private var lost: CompletableDeferred<Unit>? = null
    private val messages = Mutex()
    private val sends = Mutex()
    private val microphoneSync = Mutex()
    private var pendingCall: String? = null
    private var wakeCallId: String? = null
    private val calls by lazy { CallLifecycle(scope, state, { enabled ->
        capture.setCall(enabled); session?.callPlayback(enabled)
    }, onEnd = {
        operation?.cancel(); operation = null
        pendingCall = null; wakeCallId = null; pendingWakeId = null; wakeSender?.cancel(); wakeSender = null; wakeAudio.end()
        playback.update(false); avatarStream.end()
        queue()
    }, diagnose = { Log.w("Yimi", it) }, onFailure = { message ->
        enrollment.pairing()?.getString("device_id")?.let { ensureInbox(it).callFailure(message) }
        snapshot()
    }) }
    private var stopping: Job? = null
    private var resetEnrollment = false
    private var privatePaused = false
    private val voiceEnrollment = VoiceEnrollment()
    private val voiceSupplement = VoiceSupplement()
    private var enrolmentExpiry: Job? = null
    private var enrolmentUntil: Long? = null
    private var paymentExpiry: Job? = null
    private var paymentDeadline: PaymentNotice? = null
    private var expirePaymentMicrophone: (() -> Unit)? = null
    private val screenChanges = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val on = intent.action == Intent.ACTION_SCREEN_ON
            val commands = listOfNotNull(unlock.screen(on)) + if (on) emptyList() else voiceEnrollment.cancel()
            if (!on) inbox?.clearPayment()
            snapshot(); sendCurrent(commands)
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        Log.w("Yimi", "companion_create")
        unlock.restart()
        avatarStream.end(); avatar.start()
        scope.launch { avatarStream.phase.collect { state.value = state.value.copy(avatarPhase = it.name) } }
        enrollment = Enrollment(this); gateway = GatewayClient(enrollment, scope)
        phoneAudio.start()
        capture = FirstPersonCapture(this, scope, { bytes, _, _, trigger ->
            val photo = if (trigger == "user_request") requestedPhoto else null
            val live = checkNotNull(session)
            try {
                live.frame(bytes, trigger, photo)
                if (requestedPhoto == photo) requestedPhoto = null
            } catch (error: Exception) { photoFailed("CAMERA_CAPTURE_FAILED", photo); throw error }
        },
            { worn ->
                val request = unlock.wear(worn)
                if (!worn) { photoFailed("CAMERA_CAPTURE_CANCELLED"); inbox?.clearInteractions(); inbox?.clearPayment() }
                val cancel = if (worn) emptyList() else voiceEnrollment.cancel() + voiceSupplement.cancel()
                snapshot(); sendCurrent(listOf(unlock.wearMessage(worn)) + listOfNotNull(request) + cancel)
            }, { error -> photoFailed("CAMERA_CAPTURE_FAILED"); Log.w("Yimi", "camera_unavailable ${error.message}") })
        unlock.screen(getSystemService(PowerManager::class.java).isInteractive)
        registerReceiver(screenChanges, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON) })
        capture.setPrivacyPending(enrollment.captureRequest() != null)
        scope.launch { capture.state.collect {
            state.value = state.value.copy(capture = it)
        } }
        scope.launch { state.map { localCaptureArmed(it) to wakeTaps(it) }.distinctUntilChanged().collect { (captureArmed, taps) ->
            val enabled = enrollment.companionEnabled
            wakeAudio.standby(enabled && taps)
            wake?.listen(enabled && taps)
            microphoneSync.withLock { session?.localWake(enabled && captureArmed) }
        } }
        scope.launch { state.map { Triple(microphone(it, wakeCallId = wakeCallId), it.ambientRequestedAt, it.recording) }.distinctUntilChanged().collect { request { syncMicrophone() } } }
        scope.launch { capture.state.map { cameraReport(it).toString() }.distinctUntilChanged().collect {
            if (state.value.listening) queue(JSONObject(it).put("control_id", UUID.randomUUID().toString()))
        } }
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("yimi", "依米随身模式", NotificationManager.IMPORTANCE_LOW))
        val ambient = enrollment.ambientMode
        capture.setAmbient(ambient)
        val pair = enrollment.pairing()
        state.value = HudState(paired = pair != null, gateway = pair?.getString("origin").orEmpty(), capture = capture.state.value, paymentLock = unlock.state,
            ambient = ambient, localWakeEnabled = enrollment.localWakeEnabled, phoneAudio = state.value.phoneAudio).let { it.copy(status = if (pair == null) "配置连接" else idleStatus(it)) }
        appearance.bind(pair)
        startForeground(1, notification(ambientDisplay(state.value).text), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        scope.launch { state.map { ambientDisplay(it).text }.distinctUntilChanged().collect {
            getSystemService(NotificationManager::class.java).notify(1, notification(it))
        } }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, CompanionService::class.java).setAction("DISCONNECT"), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "yimi").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("依米").setContentText(text)
            .setContentIntent(open).addAction(Notification.Action.Builder(null, "停止", stop).build()).build()
    }
    /** Apply confirmed intent to the camera. Audio and notification follow the same HUD state. */
    private fun setAmbient(on: Boolean) {
        if (!on) photoFailed("CAMERA_CAPTURE_CANCELLED")
        capture.setAmbient(on)
        Log.i("Yimi", "ambient_mode on=$on")
    }
    /** The one place the published microphone follows [microphone]. Idempotent: the connect and every change converge. */
    private suspend fun syncMicrophone() = microphoneSync.withLock {
        supervisorScope {
            val wanted = microphone(state.value, wakeCallId = wakeCallId)
            val applying = async(start = CoroutineStart.LAZY) { session?.microphone(wanted) }
            var expired = false
            expirePaymentMicrophone = { expired = true; applying.cancel() }
            state.value = state.value.copy(microphoneApplied = null)
            try {
                if (applying.await() == true && state.value.listening && microphone(state.value, wakeCallId = wakeCallId) == wanted)
                    state.value = state.value.copy(microphoneApplied = wanted, ambientError = null)
            } catch (cancelled: CancellationException) {
                if (!expired) throw cancelled
                currentCoroutineContext().ensureActive()
            } catch (error: Exception) {
                state.value = state.value.copy(ambientError = if (error is SecurityException) "麦克风权限未开启" else error.message ?: "麦克风开启失败")
                throw error
            } finally { expirePaymentMicrophone = null }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, id: Int): Int {
        Log.w("Yimi", "companion_start restart=${intent == null}")
        val targetCall = intent?.getStringExtra("call_id")
        if (targetCall != null && targetCall != state.value.callId) return START_NOT_STICKY
        when (intent?.action ?: if (enrollment.companionEnabled) "CONNECT" else "DISCONNECT") {
            "DISCONNECT" -> {
                resetEnrollment = resetEnrollment || intent?.getBooleanExtra("clear_enrollment", false) == true
                if (resetEnrollment) state.value = state.value.copy(status = "正在断开连接", busy = true)
                if (stopping?.isActive != true) stopping = scope.launch { disconnect() }
            }
            "STOP" -> scope.launch { request {
                if (state.value.callId == null) {
                    // 「停下{errand}」: the gateway's own errand_cancel commands ride on the progress card's actions.
                    inbox?.snapshot()?.lastOrNull { it.progress != null }?.actions?.forEach { queue(it.command) }
                    operation?.cancel(); operation = null; pendingCall = null
                    playback.cancel(true); state.value = state.value.copy(busy = false, status = idleStatus(state.value))
                } else hangup()
            } }
            "RENDERED" -> if (enrollment.companionEnabled && !unlock.state.locked) {
                val ack = inbox?.snapshot()?.firstOrNull { it.id == intent!!.getStringExtra("card_id") }?.ack
                if (ack != null && canonicalJson(ack) == canonicalJson(JSONObject(intent!!.getStringExtra("receipt")!!))) {
                    inbox?.replies?.rendered(ack)?.let(::queue)
                    inbox?.companionReply?.rendered(ack, monotonicMillis()); snapshot()
                }
            }
            "PRIVATE" -> { startCompanion(); scope.launch { request { setPrivatePause() } } }
            "AVATAR" -> if (state.value.conversation?.mode != "thinking") state.value.callId?.let { queue(avatarStream.request(it, intent!!.getBooleanExtra("on", false))) }
            "MODE_CHAT", "THINK_CHAT" -> queue(calls.setConversationMode("chat"))
            "MODE_THINKING" -> queue(calls.setConversationMode("thinking"))
            "THINK_RETRY" -> queue(calls.retryThinking())
            "CAMERA" -> if (capture.state.value.error != null) capture.retry() else capture.setCallCamera(!capture.state.value.callCameraRequested)
            "RECORD" -> {
                state.value = state.value.copy(recording = !state.value.recording, microphoneApplied = null, ambientError = null)
                startCompanion()
            }
            "AMBIENT_RETRY" -> {
                ambientSwitch.retry(); capture.retry(); startCompanion()
                enrollment.captureRequest()?.let { pending -> scope.launch { request { sendPrivacy(pending) } } }
            }
            "MUTE" -> calls.toggleMute()
            "WAKE" -> {
                enrollment.localWakeEnabled = !enrollment.localWakeEnabled
                state.value = state.value.copy(localWakeEnabled = enrollment.localWakeEnabled)
                startCompanion()
            }
            "AMBIENT" -> ambientSwitch.request(intent!!.getBooleanExtra("on", false))
            "AMBIENT_CONFIRM" -> { ambientSwitch.confirm(); startCompanion() }
            "AMBIENT_CANCEL" -> ambientSwitch.cancel()
            "DISMISS" -> { inbox?.consume(intent!!.getStringExtra("card_id")!!); snapshot() }
            "APPROVE" -> {
                startCompanion()
                val card = intent!!.getStringExtra("card_id")!!
                inbox?.action(card, intent.getStringExtra("action_id")!!)?.takeIf { !unlock.state.locked }?.let { command ->
                    inbox!!.consume(card); snapshot()
                    if (command.getString("operation") == "call_offer_answer" && command.getString("answer") == "accept") {
                        pendingCall = "call_offer_answer"; state.value = state.value.copy(busy = true, status = "请稍候")
                        operation = scope.launch { request { calls.awaitClose(); send(command) } }
                    } else queue(command)
                }
            }
            "TAP" -> { startCompanion(); talk() }
            "CONNECT" -> startCompanion()
            "RIDE_START", "RIDE_STOP" -> queue(JSONObject().put("operation", "ride_control").put("action", if (intent!!.action == "RIDE_START") "start" else "stop"))
            "NAV_SWITCH" -> queue(JSONObject().put("operation", "nav_control").put("action", "switch"))
            "NAV_STOP" -> queue(JSONObject().put("operation", "nav_control").put("action", "stop"))
            "PAY_CLOSED" -> queue(JSONObject().put("operation", "pay_closed").put("at", GatewayClient.timestamp()).put("outcome", "returned"))
            "UNLOCK" -> { sendCurrent(listOfNotNull(unlock.retry())); snapshot() }
            "LOCK" -> { sendCurrent(listOf(unlock.lock()) + voiceEnrollment.cancel()); inbox?.clearPayment(); snapshot() }
            "VOICE_ENROL" -> {
                sendCurrent(voiceEnrollment.request(capture.state.value.worn == true, unlock.state.locked)); snapshot()
            }
            "SUPPLEMENT_REQUEST" -> { sendCurrent(voiceSupplement.request(capture.state.value.worn == true, unlock.state.locked)); snapshot() }
            "SUPPLEMENT_TAP" -> { sendCurrent(voiceSupplement.tap()); snapshot() }
            "SUPPLEMENT_CANCEL" -> { sendCurrent(voiceSupplement.cancel()); snapshot() }
            "VOICE_TAP", "VOICE_FINISH", "VOICE_CANCEL" -> {
                val now = monotonicMillis()
                val commands = if (unlock.state.locked) voiceEnrollment.cancel() else when (intent!!.action) {
                    "VOICE_TAP" -> voiceEnrollment.tap(now)
                    "VOICE_FINISH" -> voiceEnrollment.finish(now)
                    else -> voiceEnrollment.cancel()
                }
                sendCurrent(commands); snapshot()
            }
        }
        if (!enrollment.companionEnabled && !state.value.ambientConfirmation && stopping?.isActive != true) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
        return if (enrollment.companionEnabled) START_STICKY else START_NOT_STICKY
    }
    private fun startCompanion() {
        if (driver?.isActive == true || stopping?.isActive == true) return
        val pair = enrollment.pairing() ?: return
        appearance.bind(pair)
        enrollment.companionEnabled = true
        if (session == null) session = LiveSession(this, scope,
            { message -> messages.withLock { receive(message) } },
            { error -> Log.w("Yimi", "connection_lost cause=${error.javaClass.simpleName}"); state.value = state.value.copy(microphoneApplied = null); invalidatePayment(); capture.setAvailable(false); capture.attach(null); link.disconnected(); lost?.completeExceptionally(error) },
            { reader, packet -> playback.receive(reader, packet) },
            { playing -> state.value = state.value.copy(callPlayback = playing && state.value.callId != null) })
        val capabilities = pair.optJSONArray("capabilities")
        if (capabilities != null && (0 until capabilities.length()).any { capabilities.getString(it) == "local_wake" }) {
            val detector = wake ?: WakeWord(assets, ::heard, { availability ->
                scope.launch { state.value = state.value.copy(localWake = availability) }
            }).also { wake = it }
            session!!.hear(localAudioTap)
            wakeAudio.standby(wakeTaps(state.value, paying))
            detector.listen(wakeTaps(state.value, paying)); session!!.localWake(localCaptureArmed(state.value))
        }
        driver = scope.launch {
            try {
                link.run({ connected ->
                    val disconnected = CompletableDeferred<Unit>(); lost = disconnected
                    var recovery: Job? = null
                    try {
                        invalidatePayment()
                        Log.w("Yimi", "connection_open")
                        val binding = gateway.connect(pair)
                        calls.windowS = binding.callRejoinWindowS
                        ensureInbox(binding.deviceId)
                        val live = checkNotNull(session)
                        live.connect(binding)
                        live.awaitReady()
                        state.value = state.value.copy(ambientRequestedAt = monotonicMillis())
                        calls.ready()
                        live.send(JSONObject().put("operation", "turns_sync").put("request_id", UUID.randomUUID().toString()))
                        // The room is connected only now; microphone() skips a room still connecting.
                        syncMicrophone()
                        capture.attach(live.participant); capture.setAvailable(true)
                        live.send(unlock.wearMessage(capture.state.value.worn == true))
                        unlock.ready()?.let { live.send(it) }; snapshot()
                        connected()
                        avatarStream.replayOff()?.let(::queue)
                        if (calls.hasPendingClose || calls.hasPendingOpen) queue()
                        recovery = scope.launch { request { inbox!!.replies.observe(::send) } }
                        enrollment.captureRequest()?.let { scope.launch { request { sendPrivacy(it) } } }
                        queue(cameraReport(capture.state.value).put("control_id", UUID.randomUUID().toString()))
                        Log.w("Yimi", "connection_ready device_type=glasses")
                        live.send(JSONObject().put("operation", "avatar_sync"))
                        appearance.connected { live.send(it) }
                        disconnected.await()
                    } finally { withContext(NonCancellable) {
                        invalidatePayment()
                        appearance.disconnected()
                        link.disconnected(); capture.setAvailable(false); capture.attach(null)
                        val waiting = operation?.isActive == true || state.value.callId != null
                        if (!waiting) pendingCall = null
                        state.value = state.value.copy(listening = false, microphoneApplied = null, camera = false, foregroundCalls = emptySet(), backgroundWorkCount = null,
                            busy = waiting, status = if (waiting) "请稍候" else state.value.status)
                        calls.linkLost(); avatarStream.linkLost()
                        recovery?.cancelAndJoin()
                        if (recovery == null) inbox?.replies?.detached()
                        playback.cancel()
                        session?.detach(); gateway.clear()
                        if (!enrollment.companionEnabled) try { GatewayClient(enrollment).stop() } catch (error: Exception) { Log.w("Yimi", "media_stop failed ${error.message}") }
                    } }
                }, { error, backoff ->
                    if (error is GatewayReadinessTimeout) failedRequest(error)
                    Log.w("Yimi", "reconnect delay_ms=$backoff cause=${error.javaClass.simpleName}")
                })
            } catch (error: PairingAuthenticationLost) {
                calls.end()
                enrollment.clearPairing(); inbox?.clear()
                appearance.bind(null)
                state.value = state.value.copy(status = "眼镜配对已失效，请重新配对", paired = false, busy = false, cards = emptyList())
                stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
            }
        }
    }
    private fun queue(value: JSONObject? = null) { scope.launch { request(value) { send(value) } } }
    private suspend fun send(value: JSONObject? = null) {
        if (withTimeoutOrNull(GATEWAY_READY_TIMEOUT_MS) { sends.withLock {
            while (true) {
                link.awaitConnected()
                try {
                    val live = session!!
                    calls.closeToSend()?.let {
                        live.send(it)
                        if (session === live) calls.closePublished(it.getString("call_id"))
                    }
                    calls.openToSend()?.let { live.send(it.put("wake_word", it.getString("call_id") == wakeCallId)) }
                    value?.let { live.send(it) }
                    break
                }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: GatewayReadinessTimeout) { lost?.completeExceptionally(error); throw error }
                catch (error: Exception) { link.disconnected(); lost?.completeExceptionally(error) }
            }
        }; true } == null) throw GatewayReadinessTimeout()
    }
    private suspend fun receive(message: JSONObject) {
        when (message.getString("operation")) {
            "ready" -> {
                val epoch = message.optString("history_epoch")
                val history = getSharedPreferences("server-history", Context.MODE_PRIVATE)
                if (epoch.isNotEmpty() && epoch != history.getString("epoch", null)) {
                    playback.retireHistory(); inbox?.clear()
                    state.value = state.value.copy(backgroundWorkCount = 0, foregroundCalls = emptySet())
                    snapshot()
                    check(history.edit().putString("epoch", epoch).commit())
                }
            }
            "turns_state" -> {
                val foreground = message.getJSONArray("foreground_replies")
                val count = message.getInt("background_work_count"); require(count >= 0)
                state.value = state.value.copy(backgroundWorkCount = count,
                    foregroundCalls = (0 until foreground.length()).map { foreground.getJSONObject(it).getString("call_id") }.toSet())
            }
            "avatar_state" -> appearance.accept(message)
            "payment_notice" -> { inbox!!.accept(message); snapshot() }
            "payment_lock_state" -> {
                val commands = listOfNotNull(unlock.accept(message, monotonicMillis()))
                capture.setWearPollMs(unlock.state.wearPollMs)
                val voice = if (unlock.state.locked && voiceEnrollment.state.phase != VoiceEnrollmentPhase.AwaitingPhone)
                    voiceEnrollment.cancel() else voiceEnrollment.grant(message, monotonicMillis())
                sendCurrent(commands + voice + voiceSupplement.grant(message)); snapshot()
            }
            "payment_receipt", "voiceprint_sample", "voiceprint_owner" -> {
                if (message.getString("operation") == "payment_receipt") { unlock.receipt(message); voiceSupplement.receipt(message) }
                voiceEnrollment.accept(message, monotonicMillis()); snapshot()
            }
            "voice_enrollment_state" -> {
                voiceSupplement.accept(message)
                voiceSupplement.callToOpen()?.let { (call, draft) -> openEnrollmentCall(call, draft) }
                snapshot()
            }
            "call_state" -> {
                val accepted = calls.receive(message, pendingCall == "call_offer_answer")
                if (calls.hasPendingClose) queue()
                if (!accepted) return
                if (message.getString("state") in setOf("closing", "closed", "failed") || state.value.conversation?.mode == "thinking") avatarStream.end()
                if (message.getString("state") in setOf("opening", "connecting", "live")) {
                    pendingCall = null
                    if (wakeCallId != null && message.getString("call_id") == wakeCallId && state.value.callId == wakeCallId) {
                        // Only this matching server receipt opens the ordered PCM stream.
                        startWakeAudio(checkNotNull(wakeCallId))
                        wakeCallId = null
                        request { syncMicrophone() }
                    }
                }
                playback.update(state.value.callId != null)
            }
            "call_avatar_state" -> avatar.receive(message, state.value.callId)
            "call_playback_reset" -> if (message.getString("call_id") == state.value.callId) {
                if (message.optString("target") == "avatar") avatar.flushPlayback()
                else session!!.resetCallPlayback(message.getString("track_sid"))
            }
            "camera_capture_once" -> {
                val photo = message.getString("frame_id")
                if (requestedPhoto != null) photoFailed("CAMERA_REQUEST_BUSY", photo)
                else {
                    requestedPhoto = photo
                    if (!capture.trigger("user_request")) photoFailed("CAMERA_CAPTURE_UNAVAILABLE", photo)
                }
            }
            "camera_policy" -> {
                val policy = message.getJSONObject("policy"); capture.applyPolicy(policy); privatePaused = policy.getBoolean("private_paused")
                if (privatePaused || !policy.getBoolean("enabled")) photoFailed("CAMERA_CAPTURE_CANCELLED")
                if (message.getString("control_id") == enrollment.captureRequest()?.optString("control_id")) {
                    enrollment.saveCaptureRequest(null); capture.setPrivacyPending(false)
                }
            }
            "control_receipt" -> {
                calls.conversationReceipt(message)
                if (state.value.conversation?.mode == "thinking") avatarStream.end()
                Log.i("Yimi", "control_received operation=control_receipt")
            }
            "camera_ack", "wear_state_ack" -> Log.i("Yimi", "control_received operation=${message.getString("operation")}")
            "rejected" -> {
                val rejectedOperation = message.getString("request_operation")
                if (calls.conversationRejected(message)) return
                Log.w("Yimi", "request_rejected operation=$rejectedOperation code=${message.getString("error_code")}")
                movementRejectionHint(message)?.let { hint ->
                    inbox!!.notice(text = hint, priority = 2); snapshot(); return
                }
                if (voiceSupplement.rejected(message)) { snapshot(); return }
                if (rejectedOperation.startsWith("voiceprint_")) {
                    voiceEnrollment.accept(message, monotonicMillis()); snapshot(); return
                }
                if (rejectedOperation == "turns_sync") return
                if (inbox!!.replies.rejected(message)) return
                playback.update(state.value.callId != null)
                if (rejectedOperation == pendingCall) {
                    if (pendingCall == "call_open" || pendingCall == "call_offer_answer") {
                        calls.end()
                    }
                    pendingCall = null
                    state.value = state.value.copy(busy = false, status = if (state.value.callId == null) idleStatus(state.value) else "通话中")
                }
                notice()
            }
            "ambient_reply", "accepted", "display_card", "activity_update", "result_header", "ack_receipt" -> {
                inbox!!.accept(message, companionMode = state.value.ambient && state.value.callId == null)
                if (capture.state.value.worn != true) inbox!!.clearInteractions()
                snapshot(); inbox!!.accepted?.let(::queue); playback.update(state.value.callId != null)
                if (message.getString("operation") == "result_header") inbox!!.replies.pendingReceipts(message.getString("processed_event_id")).forEach(::queue)
            }
            "nav_route", "move_hud", "move_say", "ride_summary" -> state.value = state.value.move(message, monotonicMillis(), ServerClock.shared.nowMillis())
            // Alipay is launched from 依米's activity (its own task), so the owner lands back in 依米 when Alipay finishes.
            "pay_open" -> startActivity(packageManager.getLaunchIntentForPackage(packageName)!!.putExtra("pay", true)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            else -> Log.w("Yimi", "dropped_message operation=${message.getString("operation")}")
        }
    }
    private fun talk(wakeId: String? = null) {
        if (operation?.isActive != true) operation = scope.launch { request { openCall(wakeId) } }
    }
    // Freeze on the KWS worker before the main queue can delay call presentation.
    private fun heard() {
        val id = UUID.randomUUID().toString()
        pendingWakeId = id
        if (!wakeAudio.begin(id)) { pendingWakeId = null; return }
        scope.launch {
            val retained = wakeAudio.owns(id)
            val taps = pendingWakeId == id && retained && enrollment.companionEnabled &&
                wakeTaps(state.value, paying) && operation?.isActive != true
            // Overflow has already queued its failure callback; keep that pending identity until it reports.
            if (pendingWakeId == id && retained) pendingWakeId = null
            Log.i("Yimi", "wake_word heard tap=$taps")
            if (taps) talk(id) else {
                wakeAudio.end(id)
                wake?.listen(enrollment.companionEnabled && wakeTaps(state.value))
            }
        }
    }
    private suspend fun openCall(wakeId: String?) {
        if (state.value.callId != null) { wakeId?.let(wakeAudio::end); return }
        if (wakeId == null) { pendingWakeId?.let(wakeAudio::end); pendingWakeId = null }
        playback.cancel()
        val call = wakeId ?: UUID.randomUUID().toString(); pendingCall = "call_open"
        wakeCallId = wakeId
        state.value = state.value.copy(busy = true, status = "请稍候")
        calls.open(call)
        send()
    }
    private fun openEnrollmentCall(call: String, draft: String) {
        if (operation?.isActive == true || state.value.callId != null) return
        operation = scope.launch { request {
            playback.cancel(); pendingCall = "call_open"
            state.value = state.value.copy(busy = true, status = "请稍候")
            calls.open(call, draft)
            send()
        } }
    }
    private fun startWakeAudio(id: String) {
        wakeAudio.acknowledge(id)
        if (wakeSender?.isActive == true) return
        wakeSender = scope.launch {
            try {
                while (state.value.callId == id) {
                    wakeAudioSignal.receive()
                    wakeAudio.drain(id, ::sendWakePacket)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { failWakeAudio(id, "通话音频发送失败，请重试") }
        }
    }
    private suspend fun sendWakePacket(packet: WakePcm.Packet) {
        checkNotNull(session).send(packet.message())
        if (state.value.callId == packet.callId && !state.value.callClosing)
            state.value = state.value.copy(callPcmPublished = true)
    }
    private fun failWakeAudio(id: String, message: String) {
        if (state.value.callId != id && wakeCallId != id && pendingWakeId != id) return
        if (pendingWakeId == id) pendingWakeId = null
        if (state.value.callId == null || state.value.callId == id) { calls.hangup("error"); calls.end(id) }
        enrollment.pairing()?.getString("device_id")?.let { ensureInbox(it).callFailure(message) }
        snapshot(); queue()
    }
    private suspend fun hangup() {
        val id = state.value.callId ?: return
        avatarStream.end()
        if (wakeAudio.owns(id)) {
            val drained = try {
                withTimeoutOrNull(GATEWAY_READY_TIMEOUT_MS) {
                    wakeAudio.finish(id, ::sendWakePacket) {
                        if (state.value.callId == id) { calls.hangup(); send() }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { failWakeAudio(id, "通话尾音发送失败，请重试"); return }
            if (drained != true && state.value.callId == id) failWakeAudio(id, "通话尾音发送失败，请重试")
            return // A server close cannot be undone to deliver a late tail.
        }
        calls.hangup() ?: return
        send()
    }
    private suspend fun setPrivatePause() {
        val request = enrollment.captureRequest() ?: JSONObject().put("control_id", UUID.randomUUID().toString()).put("private_paused", !privatePaused)
        state.value = state.value.copy(ambientRequestedAt = monotonicMillis())
        capture.setPrivacyPending(true); enrollment.saveCaptureRequest(request); sendPrivacy(request)
    }
    private suspend fun sendPrivacy(request: JSONObject) { send(JSONObject(request.toString()).put("operation", "camera_private_pause")) }
    private fun photoFailed(code: String, photo: String? = requestedPhoto) {
        photo ?: return
        if (requestedPhoto == photo) requestedPhoto = null
        sendCurrent(listOf(JSONObject().put("operation", "camera_capture_failed")
            .put("frame_id", photo).put("error_code", code)))
    }
    /** Presence and enrolment commands belong to this room; never replay them onto a new wear/connection session. */
    private fun sendCurrent(commands: List<JSONObject>) {
        if (commands.isEmpty()) return
        val live = session ?: return
        scope.launch {
            try { for (command in commands) { if (session !== live) return@launch; live.send(command) } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { invalidatePayment(); lost?.completeExceptionally(error); failedRequest(error) }
        }
    }
    private fun invalidatePayment() {
        if (::enrollment.isInitialized) ambientSwitch.cancel()
        unlock.connection(false); voiceEnrollment.cancel(); voiceSupplement.cancel(); inbox?.clearPayment(); snapshot()
    }
    private suspend fun disconnect() {
        Log.w("Yimi", "companion_disconnect")
        invalidatePayment()
        enrollment.companionEnabled = false; capture.setAvailable(false); capture.attach(null)
        calls.end()
        photoFailed("CAMERA_CAPTURE_CANCELLED")
        val retired = session; val released = retired?.close(); operation?.cancel(); driver?.cancel()
        bounded("companion stop") { driver?.join(); retired?.microphoneDisabled?.await() }
        if (resetEnrollment) {
            driver?.join(); retired?.microphoneDisabled?.await(); released?.await(); enrollment.clearPairing()
            appearance.bind(null)
        }
        playback.cancel(); inbox?.clearActivities(); inbox = null; gateway.clear()
        state.value = state.value.copy(status = "已停止", paired = !resetEnrollment && state.value.paired,
            listening = false, callId = null, localWake = LocalWakeState.Off, camera = false, busy = false, micMuted = false, cards = emptyList(),
            recording = false, microphoneApplied = null, activities = emptyList(), legacyProgressCovered = false)
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    private suspend fun bounded(label: String, work: suspend () -> Unit) {
        if (withTimeoutOrNull(3000) { work(); true } == null) Log.w("Yimi", "$label timed out; abandoned old room")
    }
    private fun snapshot() {
        state.value = state.value.copy(cards = inbox?.snapshot().orEmpty(), captions = inbox?.captions().orEmpty(),
            companionReply = if (inbox == null) null else inbox?.companionReply?.snapshot(monotonicMillis()) ?: state.value.companionReply,
            activities = inbox?.activities().orEmpty(), legacyProgressCovered = inbox?.legacyProgressCovered() ?: false,
            payment = inbox?.payment(), paymentLock = unlock.state, voiceEnrollment = voiceEnrollment.state, voiceSupplement = voiceSupplement.state)
        val payment = state.value.payment
        if (paymentDeadline != payment) {
            paymentExpiry?.cancel(); paymentDeadline = payment
            paymentExpiry = payment?.takeIf { it.until != Long.MAX_VALUE }?.let { notice -> scope.launch {
                delay((notice.until - monotonicMillis()).coerceAtLeast(0))
                if (paymentDeadline === notice) {
                    paymentExpiry = null; snapshot()
                    val wanted = microphone(state.value, wakeCallId = wakeCallId)
                    if (wanted == Microphone.Off) expirePaymentMicrophone?.invoke()
                    if (state.value.microphoneApplied != wanted) syncMicrophone()
                }
            } }
        }
        val until = voiceEnrollment.state.until
        if (enrolmentUntil != until) {
            enrolmentExpiry?.cancel(); enrolmentUntil = until
            enrolmentExpiry = until?.let { scope.launch {
                delay((it - monotonicMillis()).coerceAtLeast(0))
                sendCurrent(voiceEnrollment.expire(monotonicMillis())); snapshot()
            } }
        }
    }
    private fun notice() { inbox?.notice(); snapshot() }
    private fun ensureInbox(deviceId: String): HudCards = inbox ?: HudCards(deviceId,
        FormalReplies(deviceId, enrollment.replyJournal(), enrollment::saveReplyJournal), activityChanged = ::snapshot).also { inbox = it }
    private fun failedRequest(error: Exception) {
        if (error is GatewayReadinessTimeout) calls.failOpening()
        if (error is GatewayReadinessTimeout) calls.retryClose()
        if (error is GatewayReadinessTimeout && state.value.callId == null && !calls.hasPendingClose) {
            pendingCall = null; capture.setCall(false)
            state.value = state.value.copy(callId = null, busy = false, status = error.message.orEmpty())
        }
        Log.w("Yimi", "request_failed ${error.message}"); notice()
    }
    private suspend fun request(command: JSONObject? = null, work: suspend () -> Unit) {
        try { work() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            calls.conversationFailed(command?.optString("control_id"), error.message.orEmpty())
            failedRequest(error)
        }
    }
    override fun onDestroy() {
        Log.w("Yimi", "companion_destroy")
        unregisterReceiver(screenChanges); phoneAudio.close(); invalidatePayment()
        inbox?.clearActivities()
        state.value = state.value.copy(localWake = LocalWakeState.Off, microphoneApplied = null, callPcmPublished = false, callPlayback = false,
            activities = emptyList(), legacyProgressCovered = false)
        avatarStream.end(); wakeAudio.end(); scope.cancel(); wake?.close(); capture.close(); session?.close(); gateway.clear(); super.onDestroy()
    }
}
