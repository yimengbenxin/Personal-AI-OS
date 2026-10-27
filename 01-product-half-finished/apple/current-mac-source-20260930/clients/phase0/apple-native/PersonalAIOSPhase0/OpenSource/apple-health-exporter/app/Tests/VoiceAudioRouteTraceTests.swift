import AVFAudio
import Foundation
import LiveKit
import XCTest
@testable import HealthKitExporter

final class VoiceAudioRouteTraceTests: XCTestCase {
    func testAlreadyConnectedAndChangedRoutesUseCurrentSessionSnapshot() {
        let center = NotificationCenter(), capture = RouteTraceCapture()
        capture.route = "in=BluetoothHFP out=BluetoothHFP rate=16000"
        var trace: VoiceAudioRouteTrace? = VoiceAudioRouteTrace(center: center,
            snapshot: { capture.route }, write: { capture.append($0) })
        XCTAssertTrue(capture.lines[0].contains("event=installed"))
        XCTAssertTrue(capture.lines[0].contains("out=BluetoothHFP"))
        capture.route = "in=MicrophoneBuiltIn out=Speaker rate=48000"
        center.post(name: VoiceAudioRouteTrace.routeNotification, object: nil)
        XCTAssertTrue(capture.lines.last!.contains("event=route_change"))
        XCTAssertTrue(capture.lines.last!.contains("out=Speaker"))
        XCTAssertNotNil(trace)
        trace = nil
        let count = capture.lines.count
        center.post(name: VoiceAudioRouteTrace.routeNotification, object: nil)
        XCTAssertEqual(capture.lines.count, count, "teardown removes the notification subscription")
    }

    func testConfigurationTraceIsBoundToEngineLifetimeAndPreservesChainErrors() {
        let center = NotificationCenter(), capture = RouteTraceCapture()
        let trace = VoiceAudioRouteTrace(center: center, snapshot: { "fake-session" }, write: { capture.append($0) })
        let downstream = RouteTraceDownstream()
        trace.next = downstream
        let first = AVAudioEngine(), second = AVAudioEngine()
        let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
        // These engines are observer identities only; keep the source detached from any engine graph.
        let source = AVAudioSourceNode(format: format) { silence, _, _, _ in
            silence.pointee = true
            return noErr
        }
        XCTAssertEqual(trace.engineDidCreate(first), -17)
        center.post(name: .AVAudioEngineConfigurationChange, object: first)
        XCTAssertTrue(capture.lines.last!.contains("event=engine_config_change"))
        XCTAssertEqual(trace.engineWillConnectOutput(first, src: source, dst: nil, format: format, context: [:]), -18)
        XCTAssertTrue(capture.lines.last!.contains("rate=16000.0 channels=1 result=-18"))
        XCTAssertEqual(trace.engineWillStart(first, isPlayoutEnabled: true, isRecordingEnabled: true), -19)
        XCTAssertEqual(trace.engineWillRelease(first), -20)
        let count = capture.lines.count
        center.post(name: .AVAudioEngineConfigurationChange, object: first)
        XCTAssertEqual(capture.lines.count, count)
        XCTAssertEqual(trace.engineDidCreate(second), -17)
        let before = capture.lines.count
        center.post(name: .AVAudioEngineConfigurationChange, object: first)
        XCTAssertEqual(capture.lines.count, before, "retired engines cannot emit current configuration changes")
        center.post(name: .AVAudioEngineConfigurationChange, object: second)
        XCTAssertEqual(capture.lines.count, before + 1)
        XCTAssertEqual(trace.engineWillRelease(second), -20)
    }
}

private final class RouteTraceCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRoute = "", storedLines: [String] = []
    var route: String {
        get { lock.withLock { storedRoute } }
        set { lock.withLock { storedRoute = newValue } }
    }
    var lines: [String] { lock.withLock { storedLines } }
    func append(_ line: String) { lock.withLock { storedLines.append(line) } }
}

private final class RouteTraceDownstream: AudioEngineObserver, @unchecked Sendable {
    var next: (any AudioEngineObserver)?
    func engineDidCreate(_ engine: AVAudioEngine) -> Int { -17 }
    func engineWillConnectOutput(_ engine: AVAudioEngine, src: AVAudioNode, dst: AVAudioNode?, format: AVAudioFormat, context: [AnyHashable: Any]) -> Int { -18 }
    func engineWillStart(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int { -19 }
    func engineWillRelease(_ engine: AVAudioEngine) -> Int { -20 }
}
