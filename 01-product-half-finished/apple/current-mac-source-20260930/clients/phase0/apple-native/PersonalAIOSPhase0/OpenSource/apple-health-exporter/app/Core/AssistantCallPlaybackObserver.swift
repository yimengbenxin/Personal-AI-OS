import AVFAudio
import Foundation
import LiveKit

/// Projects rendered remote PCM, rather than the server's intention to speak. Audible means a peak above `floor`: the
/// decoded track between her sentences is not exact zeros but a noise floor of a few LSB, and counting any non-zero sample
/// as speech flipped 依米正在说话 ↔ 正在听你说 (and the Live Activity with it) many times a second for the whole call.
/// She stops speaking only after `release` without an audible buffer, so pauses between her words keep one span.
final class AssistantCallPlaybackObserver: AudioRenderer, @unchecked Sendable {
    static let floor: Float = 0.01   // about -40 dBFS
    static let release: TimeInterval = 0.8
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ai.paios.call.playback-status")
    private var expiry: DispatchWorkItem?
    private var playing = false
    private var stopped = false
    private let changed: @Sendable (Bool) -> Void

    init(changed: @escaping @Sendable (Bool) -> Void) { self.changed = changed }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let frames = Int(pcmBuffer.frameLength)
        guard frames > 0 else { return }
        let channels = Int(pcmBuffer.format.channelCount)
        let audible: Bool
        if let data = pcmBuffer.int16ChannelData {
            let floor = UInt16(Self.floor * Float(Int16.max))
            audible = (0..<channels).contains { channel in
                (0..<frames).contains { data[pcmBuffer.format.isInterleaved ? 0 : channel][$0 * pcmBuffer.stride + (pcmBuffer.format.isInterleaved ? channel : 0)].magnitude >= floor }
            }
        } else if let data = pcmBuffer.floatChannelData {
            audible = (0..<channels).contains { channel in
                (0..<frames).contains { abs(data[pcmBuffer.format.isInterleaved ? 0 : channel][$0 * pcmBuffer.stride + (pcmBuffer.format.isInterleaved ? channel : 0)]) >= Self.floor }
            }
        } else { return }
        guard audible else { return }
        queue.async { [self] in
            let item = DispatchWorkItem { [weak self] in self?.silence() }
            let started = lock.withLock { () -> Bool? in
                guard !stopped else { return nil }
                expiry?.cancel(); expiry = item
                defer { playing = true }
                return !playing
            }
            guard let started else { return }
            if started { changed(true) }
            queue.asyncAfter(deadline: .now() + Self.release, execute: item)
        }
    }

    private func silence() {
        let notify = lock.withLock { let old = playing; playing = false; return old }
        if notify { changed(false) }
    }

    func stop() {
        lock.withLock { stopped = true; expiry?.cancel(); expiry = nil }
        queue.async { [self] in silence() }
    }
}
