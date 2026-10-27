package com.personalaios.glasses

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import io.livekit.android.room.datastream.incoming.ByteStreamReceiver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun cancelPlaybackControl(packet: JSONObject): JSONObject =
    JSONObject().put("operation", "cancel_playback").put("control_id", UUID.randomUUID().toString())
        .put("processed_event_id", packet.getString("processed_event_id"))
        .put("reply_epoch", packet.getJSONObject("chunk").getLong("reply_epoch"))

/** Owns local voice playback; ordered receipts remain in FormalReplies. */
class VoicePlayback(private val context: Context, private val scope: CoroutineScope,
    private val replies: () -> FormalReplies?, private val send: (JSONObject) -> Unit,
    private val onError: (Exception) -> Unit,
    private val onPlayback: (JSONObject, Boolean) -> Unit = { _, _ -> }) {
    private val queued = mutableListOf<Pair<JSONObject, File>>()
    private val receiving = mutableMapOf<Job, JSONObject>()
    private val cancellation = Mutex()
    private var playing: JSONObject? = null
    private var voice: Job? = null
    private var inCall = false
    private var cancelling = false

    suspend fun receive(reader: ByteStreamReceiver, packet: JSONObject) {
        if (cancelling) return
        val job = currentCoroutineContext()[Job]!!
        receiving[job] = packet
        try {
            val authority = replies() ?: return
            authority.awaitHeader(packet)
            if (!authority.admitVoice(packet)) {
                authority.pendingReceipts(packet.getString("processed_event_id")).forEach(send)
                return
            }
            var retained = false
            try {
                val file = spool(reader, packet)
                if (receiving.containsKey(job) && replies() === authority && authority.voiceCurrent(packet) && !inCall) {
                    queued.add(packet to file); retained = true; update(inCall)
                } else file.delete()
            } finally { if (!retained) authority.releaseVoice(packet) }
        } finally { receiving.remove(job) }
    }

    fun update(inCall: Boolean) {
        this.inCall = inCall
        val authority = replies()
        if (inCall || playing?.let { authority?.voiceCurrent(it) != true } == true) voice?.cancel()
        queued.removeAll { (packet, file) ->
            if (inCall || authority?.voiceCurrent(packet) != true) {
                authority?.releaseVoice(packet); file.delete(); true
            } else false
        }
        if (voice != null || inCall || cancelling || authority == null || queued.none { authority.canPlay(it.first) }) return
        voice = scope.launch(start = CoroutineStart.LAZY) {
            try {
                while (!this@VoicePlayback.inCall) {
                    val item = queued.firstOrNull { authority.canPlay(it.first) } ?: break
                    queued.remove(item); playing = item.first
                    try {
                        play(item.second, item.first)
                        if (replies() === authority && authority.canPlay(item.first)) send(authority.played(item.first))
                    } finally { authority.releaseVoice(item.first); onPlayback(item.first, false); playing = null }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { onError(error) }
            finally {
                if (voice === currentCoroutineContext()[Job]) {
                    voice = null
                    if (!cancelling) update(this@VoicePlayback.inCall)
                }
            }
        }
        voice!!.start()
    }

    suspend fun cancel(notify: Boolean = false) = cancellation.withLock {
        val downloads = receiving.toMap()
        val packets = (listOfNotNull(playing) + downloads.values).toMutableList()
        cancelling = true
        receiving.clear()
        try {
            downloads.keys.forEach { it.cancel() }
            voice?.cancel()
            downloads.keys.forEach { it.join() }
            voice?.join()
        }
        finally {
            voice = null; playing = null
            queued.forEach { (packet, file) -> packets.add(packet); replies()?.releaseVoice(packet); file.delete() }
            queued.clear(); cancelling = false
        }
        if (notify) packets.distinctBy { it.getString("processed_event_id") to it.getJSONObject("chunk").getLong("reply_epoch") }.forEach {
            send(cancelPlaybackControl(it))
        }
    }

    private suspend fun spool(reader: ByteStreamReceiver, packet: JSONObject): File {
        val audio = packet.getJSONObject("chunk").getJSONObject("audio")
        val expected = audio.getLong("bytes")
        val file = File.createTempFile("voice-", ".wav", context.cacheDir)
        var retained = false
        try {
            withContext(Dispatchers.IO) {
                val digest = MessageDigest.getInstance("SHA-256")
                var size = 0L
                file.outputStream().use { output -> reader.flow.collect { bytes ->
                    size += bytes.size
                    require(size <= expected) { "Voice resource exceeds its declared size" }
                    digest.update(bytes)
                    output.write(bytes)
                } }
                require(size == expected) { "Voice resource size differs from its declaration" }
                require(digest.digest().joinToString("") { "%02x".format(it) } == audio.getString("sha256")) {
                    "Voice resource SHA-256 differs from its declaration"
                }
            }
            retained = true
            return file
        } finally { if (!retained) file.delete() }
    }

    /** Authenticated server history generation; also remove audio orphaned by an earlier process exit. */
    suspend fun retireHistory() {
        cancel()
        withContext(Dispatchers.IO) {
            context.cacheDir.listFiles()?.filter { it.isFile && it.name.startsWith("voice-") && it.extension == "wav" }
                ?.forEach { check(it.delete()) }
        }
    }

    private suspend fun play(file: File, packet: JSONObject) {
        try {
            withContext(Dispatchers.Main) {
                val player = MediaPlayer()
                try {
                    player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    player.setDataSource(file.path)
                    suspendCancellableCoroutine<Unit> { done ->
                        player.setOnPreparedListener {
                            if (done.isActive) {
                                try { it.start(); onPlayback(packet, true) }
                                catch (error: Exception) { done.resumeWithException(error) }
                            }
                        }
                        player.setOnCompletionListener { if (done.isActive) done.resume(Unit) }
                        player.setOnErrorListener { _, what, extra ->
                            if (done.isActive) done.resumeWithException(IllegalStateException("Voice playback failed $what/$extra"))
                            true
                        }
                        player.prepareAsync()
                    }
                } finally { player.release() }
            }
        } finally { file.delete() }
    }
}
