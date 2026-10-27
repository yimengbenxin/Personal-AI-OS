package com.personalaios.glasses

import android.content.Context
import android.media.MediaRecorder
import android.util.Log
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioFocusHandler
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.datastream.incoming.ByteStreamReceiver
import io.livekit.android.room.datastream.StreamBytesOptions
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.Track
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.TrackPublication
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import livekit.LivekitModels
import livekit.org.webrtc.AudioTrackSink
import org.json.JSONObject

internal fun formalPacket(bytes: ByteArray, sessionId: String): JSONObject {
    return JSONObject(String(bytes, Charsets.UTF_8)).also {
        require(it.getString("schema_version") == "paios.central.text-envelope.v1" && it.getString("session_id") == sessionId)
        if (it.getString("operation") == "ready") {
            require(it.keys().asSequence().toSet().all { key -> key in setOf("schema_version", "session_id", "operation", "history_epoch") })
            if (it.has("history_epoch")) require(it.getString("history_epoch").matches(Regex("^[a-f0-9]{32}$")))
        }
    }
}

/** Only wake PCM has the formal ingress envelope; its session always comes from the active transport binding. */
internal fun outboundPacket(value: JSONObject, sessionId: String): JSONObject =
    if (value.getString("operation") == "call_pcm") JSONObject(value.toString())
        .put("schema_version", "paios.central.text-envelope.v1").put("session_id", sessionId)
    else value

/** External LiveKit transport only. Gateway and the central consumers own protocol state. */
@OptIn(io.livekit.android.annotations.Beta::class)
class LiveSession(private val context: Context, private val scope: CoroutineScope,
    private val onMessage: suspend (JSONObject) -> Unit, private val onFailure: (Throwable) -> Unit,
    private val onVoice: suspend (ByteStreamReceiver, JSONObject) -> Unit,
    private val onPlayback: (Boolean) -> Unit = {}) {
    @Volatile private var room: Room? = null
    private var engine: Room? = null
    private var localMicrophone: LocalAudioTrack? = null
    private var localWake = false
    private val speakers = mutableMapOf<RemoteAudioTrack, AudioTrackSink>()
    private val audioFocus by lazy { AudioFocusHandler(context) }
    @Volatile private var playbackEnabled = false
    fun callPlayback(enabled: Boolean) {
        if (enabled != playbackEnabled) {
            if (enabled) audioFocus.start() else audioFocus.stop()
        }
        playbackEnabled = enabled
        speakers.keys.forEach { it.setVolume(if (enabled) 1.0 else 0.0) }
        if (!enabled) { playbackExpiry?.cancel(); onPlayback(false) }
    }
    private var playbackExpiry: Job? = null
    @Volatile private var lastPlaybackAt = 0L
    private var binding: GatewayClient.Connection? = null
    private var roomScope: CoroutineScope? = null
    private var cleanup: Deferred<Unit>? = null
    private val gatewayReady = ConnectionLoop()
    private val cameraReceipt = CameraFrameReceipt()
    var microphoneDisabled: Deferred<Unit> = CompletableDeferred(Unit)
        private set

    suspend fun connect(binding: GatewayClient.Connection) {
        check(room == null) { "LiveKit is already connected" }
        gatewayReady.disconnected()
        // The key provider is native WebRTC, which LiveKit.create would load only afterwards: in a fresh process it threw
        // UnsatisfiedLinkError on the glasses' first accepted Start.
        LiveKit.init(context.applicationContext)
        val provider = BaseKeyProvider(ratchetWindowSize = 0)
        check(provider.rtcKeyProvider.setSharedKey(0, binding.contentKey)) { "E2EE key was rejected" }
        val candidate = localEngine()
        candidate.setRoomOptions(RoomOptions(e2eeOptions = E2EEOptions(provider)))
        candidate.localParticipant.videoTrackCaptureDefaults = LocalVideoTrackOptions(position = CameraPosition.BACK, captureParams = VideoCaptureParameter(1440, 1080, 15))
        val activeScope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        room = candidate; this.binding = binding; roomScope = activeScope
        candidate.registerTextStreamHandler("paios.central.sealed-text.v1") { receiver, sender ->
            if (!trusted(candidate, sender.value, receiver.info.encryptionType)) return@registerTextStreamHandler
            activeScope.launch {
                boundary(candidate) {
                    val bytes = java.io.ByteArrayOutputStream()
                    receiver.flow.collect { chunk ->
                        val encoded = chunk.toByteArray(Charsets.UTF_8)
                        require(bytes.size() + encoded.size <= 12288) { "Ready stream exceeds formal envelope limit" }
                        bytes.write(encoded)
                    }
                    val value = formalPacket(bytes.toByteArray(), binding.sessionId)
                    require(room === candidate && value.getString("operation") == "ready")
                    onMessage(value)
                    gatewayReady.connected()
                }
            }
        }
        candidate.registerByteStreamHandler("paios.central.voice.v1") { receiver, sender ->
            if (!trusted(candidate, sender.value, receiver.info.encryptionType)) return@registerByteStreamHandler
            activeScope.launch {
                boundary(candidate) {
                    val packet = formalPacket(receiver.info.attributes.getValue("out").toByteArray(), binding.sessionId)
                    require(packet.getString("operation") == "voice_chunk")
                    onVoice(receiver, packet)
                }
            }
        }
        activeScope.launch {
            candidate.events.collect { event ->
                if (room !== candidate) return@collect
                when (event) {
                    // The SDK leaves the sender out of decrypted data packets. Only this
                    // session's gateway holds its key, so as on the iPhone a missing sender is accepted and a named one must match.
                    is RoomEvent.DataReceived -> if (event.topic == "paios.central.sealed-text.v1" &&
                        trusted(candidate, event.participant?.identity?.value ?: binding.gatewayIdentity, event.encryptionType)) {
                        boundary(candidate) {
                            val value = formalPacket(event.data, binding.sessionId)
                            require(value.getString("operation") != "ready")
                            cameraReceipt.receive(value)
                            onMessage(value)
                        }
                    } else Log.w("Yimi", "dropped_data topic=${event.topic} sender=${event.participant?.identity?.value} " +
                        "gateway=${binding.gatewayIdentity} encryption=${event.encryptionType}")
                    is RoomEvent.Reconnecting -> fail(candidate, java.io.IOException("LiveKit transport lost; refresh gateway policy"))
                    is RoomEvent.FailedToConnect -> fail(candidate, event.error)
                    is RoomEvent.TrackSubscribed -> (event.track as? RemoteAudioTrack)?.let { track ->
                        val sink = object : AudioTrackSink {
                            override fun onData(data: java.nio.ByteBuffer, bits: Int, rate: Int, channels: Int, frames: Int, at: Long) {
                                if (!playbackEnabled || bits != 16) return
                                val samples = data.duplicate().order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                                if ((0 until samples.remaining()).none { kotlin.math.abs(samples.get(it).toInt()) > 32 }) return
                                val tick = android.os.SystemClock.elapsedRealtime()
                                if (tick - lastPlaybackAt < 100) return
                                lastPlaybackAt = tick
                                activeScope.launch playback@{
                                    if (room !== candidate || !playbackEnabled) return@playback
                                    onPlayback(true); playbackExpiry?.cancel()
                                    playbackExpiry = activeScope.launch { delay(250); onPlayback(false) }
                                }
                            }
                        }
                        track.setVolume(if (playbackEnabled) 1.0 else 0.0)
                        speakers[track] = sink; track.addSink(sink)
                    }
                    is RoomEvent.TrackUnsubscribed -> (event.track as? RemoteAudioTrack)?.let { track ->
                        speakers.remove(track)?.let(track::removeSink)
                        if (speakers.isEmpty()) { playbackExpiry?.cancel(); onPlayback(false) }
                    }
                    is RoomEvent.TrackPublished -> subscribe(candidate, event.participant, event.publication)
                    is RoomEvent.ParticipantConnected -> event.participant.trackPublications.values.forEach { subscribe(candidate, event.participant, it) }
                    is RoomEvent.ParticipantDisconnected -> if (event.participant.identity?.value == binding.gatewayIdentity) fail(candidate, java.io.IOException("Gateway participant disconnected"))
                    is RoomEvent.TrackSubscriptionFailed -> if (event.participant.identity?.value == binding.gatewayIdentity) fail(candidate, event.exception)
                    is RoomEvent.Disconnected -> fail(candidate, event.error ?: IllegalStateException("LiveKit disconnected: ${event.reason}"))
                    is RoomEvent.TrackE2EEStateEvent -> if (event.state in setOf(E2EEState.MISSING_KEY, E2EEState.ENCRYPTION_FAILED,
                        E2EEState.DECRYPTION_FAILED, E2EEState.INTERNAL_ERROR)) fail(candidate, IllegalStateException("LiveKit E2EE: ${event.state}"))
                    else -> Unit
                }
            }
        }
        try {
            candidate.connect(binding.url, binding.token, ConnectOptions(autoSubscribe = false))
            checkNotNull(candidate.e2eeManager).dataChannelEncryptionEnabled = true
            candidate.remoteParticipants.values.forEach { participant -> participant.trackPublications.values.forEach { subscribe(candidate, participant, it) } }
        }
        catch (error: Throwable) { retire(candidate); throw error }
    }

    private fun trusted(candidate: Room, sender: String?, encryption: LivekitModels.Encryption.Type): Boolean =
        room === candidate && sender == binding?.gatewayIdentity && encryption == LivekitModels.Encryption.Type.GCM

    private fun subscribe(candidate: Room, participant: Participant, publication: TrackPublication) {
        if (publication is RemoteTrackPublication) publication.setSubscribed(trusted(candidate, participant.identity?.value, publication.encryptionType))
    }

    private suspend fun boundary(candidate: Room, action: suspend () -> Unit) {
        try { if (room === candidate) action() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { Log.w("Yimi", "dropped_message ${error.javaClass.simpleName}: ${error.message}") }
    }
    private fun fail(candidate: Room, error: Throwable) {
        if (room !== candidate) return
        onFailure(error); retire(candidate)
    }
    private fun retire(candidate: Room) {
        if (room !== candidate) return
        callPlayback(false); onPlayback(false)
        speakers.forEach { (track, sink) -> track.removeSink(sink) }; speakers.clear()
        gatewayReady.failed(java.io.IOException("Gateway participant disconnected"))
        cameraReceipt.disconnected(java.io.IOException("Gateway participant disconnected"))
        room = null; binding = null; roomScope?.cancel(); roomScope = null
        localMicrophone?.let { candidate.localParticipant.unpublishTrack(it, stopOnUnpublish = false) }
        candidate.disconnect()
        candidate.unregisterTextStreamHandler("paios.central.sealed-text.v1")
        candidate.unregisterByteStreamHandler("paios.central.voice.v1")
        // dispose() is idempotent, including when the SDK already disposed a published track on disconnect.
        releaseLocalCapture()
        if (localWake) refreshLocalCapture()
    }
    private fun localEngine(): Room = engine ?: run {
        LiveKit.init(context.applicationContext)
        // A persistent transport must not take focus or reset the phone's HFP route. Our call owns focus above.
        val audio = AudioOptions(audioOutputType = AudioType.MediaAudioType(), audioHandler = NoAudioHandler(), javaAudioDeviceModuleCustomizer = { builder ->
            builder.setAudioSource(MediaRecorder.AudioSource.MIC)
        })
        LiveKit.create(context, overrides = LiveKitOverrides(audioOptions = audio)).also { engine = it }
    }
    private fun refreshLocalCapture(): LocalAudioTrack {
        val track = localMicrophone ?: localEngine().localParticipant.createAudioTrack().also {
            localMicrophone = it; listener?.let(it::addSink)
        }
        if (localWake) track.prewarm()
        return track
    }
    private fun releaseLocalCapture() {
        localMicrophone?.let { track ->
            track.stopPrewarm(); track.stop(); track.dispose()
            localMicrophone = null
        }
    }
    /** Local-only capture uses the SDK's recorder, including while the transport is disconnected. */
    fun localWake(on: Boolean) {
        localWake = on
        if (on) refreshLocalCapture()
        else if (room?.localParticipant?.getTrackPublication(Track.Source.MICROPHONE) == null) releaseLocalCapture()
    }
    suspend fun send(value: JSONObject) {
        val active = checkNotNull(room) { "LiveKit is disconnected" }
        awaitReady()
        check(room === active) { "LiveKit connection changed" }
        check(active.e2eeManager?.isDataChannelEncryptionEnabled() == true) { "LiveKit encrypted data is unavailable" }
        val current = checkNotNull(binding)
        val bytes = outboundPacket(value, current.sessionId).toString().toByteArray(Charsets.UTF_8)
        active.localParticipant.publishData(bytes, topic = "paios.central.text.v1",
            identities = listOf(Participant.Identity(current.gatewayIdentity))).getOrThrow()
    }
    suspend fun awaitReady() = gatewayReady.awaitConnected(GATEWAY_READY_TIMEOUT_MS)
    /** Idempotent; a room still connecting takes the value from the connect itself. */
    suspend fun microphone(value: Microphone): Boolean {
        val active = room?.takeIf { it.state == Room.State.CONNECTED } ?: return false
        val participant = active.localParticipant
        val publication = participant.getTrackPublication(Track.Source.MICROPHONE)
        val track = refreshLocalCapture()
        try {
            when {
                value == Microphone.On -> {
                    track.prewarm(); track.start()
                    if (publication == null) check(participant.publishAudioTrack(track)) { "Microphone publication failed" }
                    else publication.muted = false
                }
                value == Microphone.Muted -> publication?.muted = true
                else -> {
                    participant.unpublishTrack(track, stopOnUnpublish = false)
                    if (!localWake) releaseLocalCapture()
                }
            }
        }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { fail(active, error); throw error }
        Log.i("Yimi", "microphone ${value.name.lowercase()}")
        return room === active && active.state == Room.State.CONNECTED
    }
    private var listener: AudioTrackSink? = null
    fun hear(sink: AudioTrackSink) {
        localMicrophone?.let { track -> listener?.let(track::removeSink) }
        listener = sink
        localMicrophone?.addSink(sink)
    }
    val participant get() = room?.localParticipant
    suspend fun frame(bytes: ByteArray, trigger: String, requestedFrame: String? = null) {
        val active = checkNotNull(room)
        check(active.e2eeManager?.isDataChannelEncryptionEnabled() == true) { "LiveKit encrypted data is unavailable" }
        val frameId = requestedFrame ?: java.util.UUID.randomUUID().toString()
        val metadata = JSONObject().put("frame_id", frameId).put("captured_at", GatewayClient.timestamp())
            .put("trigger", trigger)
            .put("worn", true).put("private_paused", false)
        val receipt = cameraReceipt.start(frameId)
        try {
            withTimeout(30000) {
                val stream = active.localParticipant.streamBytes(StreamBytesOptions(topic = "paios.assistant.camera.v1",
                    attributes = mapOf("frame" to metadata.toString()), mimeType = "image/jpeg", totalSize = bytes.size.toLong(),
                    destinationIdentities = listOf(Participant.Identity(binding!!.gatewayIdentity))))
                try { stream.write(bytes).getOrThrow() } finally { stream.close() }
                receipt.await()
            }
        } finally { cameraReceipt.finish(receipt) }
    }
    suspend fun resetCallPlayback(trackSid: String) {
        val active = checkNotNull(room)
        val gateway = active.remoteParticipants.values.singleOrNull { it.identity?.value == binding?.gatewayIdentity } ?: return
        val publication = gateway.trackPublications.values.singleOrNull { it.sid == trackSid } as? RemoteTrackPublication ?: return
        publication.setSubscribed(false); delay(100)
        if (trusted(active, gateway.identity?.value, publication.encryptionType)) publication.setSubscribed(true)
    }
    fun detach() { room?.let(::retire) }
    fun close(): Deferred<Unit>? {
        callPlayback(false)
        localWake = false; room?.let(::retire)
        val track = localMicrophone; localMicrophone = null
        val retired = engine; engine = null
        microphoneDisabled = scope.async(NonCancellable + Dispatchers.IO) { track?.stopPrewarm(); track?.stop(); track?.dispose() }
        cleanup = scope.async(NonCancellable + Dispatchers.IO) { microphoneDisabled.await(); retired?.release() }
        return cleanup
    }
}
