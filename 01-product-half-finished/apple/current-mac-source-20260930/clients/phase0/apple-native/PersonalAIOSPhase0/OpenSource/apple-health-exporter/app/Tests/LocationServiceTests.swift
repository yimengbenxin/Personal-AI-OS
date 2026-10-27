import CoreLocation
import XCTest
@testable import HealthKitExporter

@MainActor
final class LocationServiceTests: XCTestCase {
    func testSharedBackgroundConfigurationKeepsUpdatesWithoutRequestingIndicatorForEveryAuthorization() {
        for status in [CLAuthorizationStatus.notDetermined, .restricted, .denied, .authorizedAlways,
                       CLAuthorizationStatus(rawValue: 4)!] {
            let manager = BackgroundLocationManagerSpy(status: status)
            LocationService.configureBackgroundLocation(manager)
            XCTAssertTrue(manager.allowsBackgroundLocationUpdates, "authorization=\(status.rawValue)")
            XCTAssertFalse(manager.showsBackgroundLocationIndicator, "authorization=\(status.rawValue)")
            XCTAssertEqual(manager.status, status)
        }
    }

#if os(macOS)
    func testStandbyAndMoveSensorsUseTheSharedBackgroundConfiguration() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        for (file, manager) in [("LocationService.swift", "manager"), ("MoveSessionSensors.swift", "location")] {
            let source = try String(contentsOf: app.appendingPathComponent("Core/" + file), encoding: .utf8)
            XCTAssertTrue(source.contains("LocationService.configureBackgroundLocation(\(manager))"), file)
            XCTAssertFalse(source.contains("showsBackgroundLocationIndicator = true"), file)
            XCTAssertEqual(source.components(separatedBy: "allowsBackgroundLocationUpdates = true").count - 1,
                           file == "LocationService.swift" ? 1 : 0, file)
        }
    }
#endif

    func testAlwaysUpgradeWaitsForForegroundAfterWhenInUsePrompt() async throws {
        let domain = "nav-standby-\(UUID())", manager = TestLocationManager()
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        var foreground = true, requests = 0
        manager.status = .notDetermined
        manager.onWhenInUseRequest = {
            foreground = false
            manager.status = CLAuthorizationStatus(rawValue: 4)!
            manager.delegate?.locationManagerDidChangeAuthorization?(manager)
        }
        let service = LocationService(manager: manager, defaults: defaults,
            requestAlways: { requests += 1 }, isForeground: { foreground })
        try await service.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true)
        XCTAssertEqual(requests, 0)
        foreground = true
        try await service.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true)
        try await service.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true)
        XCTAssertEqual(requests, 1)
    }

    func testPairedGlassesAskAlwaysOnceAcrossLaunchesWithoutPlaces() async throws {
        let domain = "nav-standby-\(UUID())"
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let manager = TestLocationManager()
        manager.status = CLAuthorizationStatus(rawValue: 4)!
        var requests = 0
        let service = LocationService(manager: manager, defaults: defaults, requestAlways: { requests += 1 },
            isForeground: { true })
        try await service.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true)
        try await service.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true)
        let relaunched = LocationService(manager: manager, defaults: defaults, requestAlways: { requests += 1 },
            isForeground: { true })
        try await relaunched.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true)
        XCTAssertEqual(requests, 1)
    }

    func testGlassesAlwaysRequestNeedsExplicitForegroundAction() async {
        let service = LocationService(manager: TestLocationManager())
        do { try await service.requestAlwaysAuthorization(userInitiated: false, glassesPaired: true); XCTFail("Explicit action required") }
        catch { XCTAssertEqual(error as? AssistantLocationError, .requestWasNotUserInitiated) }
        let background = LocationService(manager: TestLocationManager(), isForeground: { false })
        do { try await background.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true); XCTFail("Foreground required") }
        catch { XCTAssertEqual(error as? AssistantLocationError, .requestWasNotUserInitiated) }
    }

    func testFeedHasOneOwnerUnionAndStopsAfterBothEnd() {
        let manager = TestLocationManager()
        let feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: TestLocationManager()), manager: manager)
        func sync(_ ambient: Bool, _ paired: Bool, _ enabled: Bool = true) {
            feed.syncOwners(ambient: ambient, glassesPaired: paired, locationEnabled: enabled,
                consent: 1, report: { _, _, _ in }, reconnect: {})
        }
        manager.status = CLAuthorizationStatus(rawValue: 4)!
        sync(false, true); XCTAssertFalse(feed.isRunning)
        sync(true, false); XCTAssertTrue(feed.isRunning)
        manager.status = .authorizedAlways
        sync(true, true); sync(false, true)
        XCTAssertTrue(feed.isRunning); XCTAssertEqual(manager.starts, 1)
        XCTAssertEqual(manager.significantStarts, 1)
        sync(false, false); XCTAssertFalse(feed.isRunning)
        XCTAssertEqual(manager.stops, 1); XCTAssertEqual(manager.significantStops, 1)
        sync(true, true, false); XCTAssertFalse(feed.isRunning)
        manager.status = .denied
        sync(true, true); XCTAssertFalse(feed.isRunning)
    }

    func testRelaunchedFeedReconnectsAtStartAndLocationWake() async {
        let manager = TestLocationManager()
        let feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: TestLocationManager()), manager: manager)
        let wake = expectation(description: "start and location wake reconnect")
        wake.expectedFulfillmentCount = 2
        feed.syncOwners(ambient: false, glassesPaired: true, locationEnabled: true,
            consent: 1, report: { _, _, _ in }, reconnect: { wake.fulfill() })
        XCTAssertTrue(feed.isRunning); XCTAssertTrue(feed.navigationStandby)
        manager.requestLocation()
        await fulfillment(of: [wake], timeout: 1)
        feed.stop()
    }

    func testMapsWhenInUseAndAlwaysToAuthorized() {
#if !os(macOS)
        XCTAssertEqual(
            LocationService.map(.authorizedWhenInUse),
            .authorized
        )
#endif
        XCTAssertEqual(
            LocationService.map(.authorizedAlways),
            .authorized
        )
    }

    func testMapsDeniedAndRestrictedWithoutEscalation() {
        XCTAssertEqual(LocationService.map(.denied), .denied)
        XCTAssertEqual(LocationService.map(.restricted), .restricted)
    }

    func testMapsNotDeterminedWithoutRequestingAtLaunch() {
        XCTAssertEqual(
            LocationService.map(.notDetermined),
            .notDetermined
        )
    }

    func testObservationQualityMarksStaleAndLowAccuracyAsDegraded() {
        let stale = AssistantLocationObservation(
            localCaptureID: "stale",
            latitude: 1,
            longitude: 2,
            horizontalAccuracy: 10,
            observedAt: Date(timeIntervalSinceNow: -301)
        )
        let lowAccuracy = AssistantLocationObservation(
            localCaptureID: "low",
            latitude: 1,
            longitude: 2,
            horizontalAccuracy: 1_001,
            observedAt: Date()
        )
        XCTAssertEqual(stale.quality, .degraded)
        XCTAssertEqual(lowAccuracy.quality, .degraded)
    }

    func testObservationQualityMarksInvalidAccuracyUnavailable() {
        let invalid = AssistantLocationObservation(
            localCaptureID: "invalid",
            latitude: 1,
            longitude: 2,
            horizontalAccuracy: -1,
            observedAt: Date()
        )
        XCTAssertEqual(invalid.quality, .unavailable)
    }

    func testOneShotRejectsCachedPositionAndAcceptsANewSensorFixAfterMovement() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager, isForeground: { false })
        manager.cached = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 1, longitude: 2),
            altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: Date(timeIntervalSinceNow: -1_200))
        var completed = false
        let request = Task { defer { completed = true }; return try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(completed, "An initial cached callback must leave time for a new measurement")
        XCTAssertEqual(manager.starts, 1)
        XCTAssertEqual(manager.requestCount, 0)
        manager.deliver(timestamp: Date())
        let moved = try await request.value
        XCTAssertEqual([moved.latitude, moved.longitude], [3, 4])
        XCTAssertEqual(moved.observedAt, manager.delivered?.timestamp)
        XCTAssertEqual(manager.stops, 1)
    }

    func testCachedOnlyOneShotTimesOutAndStopsPreciseUpdates() async {
        let manager = TestLocationManager(), service = LocationService(manager: manager, oneShotTimeout: 20_000_000)
        manager.cached = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 1, longitude: 2),
            altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: Date(timeIntervalSinceNow: -240))
        do { _ = try await service.requestOneShot(userInitiated: false); XCTFail("A cache cannot satisfy the request") }
        catch { XCTAssertEqual(AssistantLocationUnavailableReason(error), .timeout) }
        XCTAssertEqual(manager.stops, 1)
        let age = service.cachedFixAgeMilliseconds()
        XCTAssertGreaterThanOrEqual(age ?? 0, 240_000)
        XCTAssertLessThan(age ?? 0, 241_000)
    }

    func testReducedAccuracyIsExplicitAndNeverStartsPreciseUpdates() async {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.accuracy = .reducedAccuracy
        do { _ = try await service.requestOneShot(userInitiated: false); XCTFail("Precise location is disabled") }
        catch { XCTAssertEqual(AssistantLocationUnavailableReason(error).rawValue, "reduced_accuracy") }
        XCTAssertEqual(manager.starts, 0)
        XCTAssertEqual(manager.requestCount, 0)
    }

    func testTemporaryLocationUnknownWaitsForTheFreshFix() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.failure = .locationUnknown
        let request = Task { try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(manager.stops, 0)
        manager.deliver(timestamp: Date())
        let fix = try await request.value
        XCTAssertEqual(fix.observedAt, manager.delivered?.timestamp)
        XCTAssertEqual(manager.stops, 1)
    }

    func testCancellingLastCallerStopsBurstAndNextRequestStartsCleanly() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.silent = true
        let request = Task { try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<10 { await Task.yield() }
        request.cancel()
        do { _ = try await request.value; XCTFail("Cancelled request must end") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(manager.stops, 1)
        manager.silent = false
        _ = try await service.requestOneShot(userInitiated: false)
        XCTAssertEqual(manager.starts, 2); XCTAssertEqual(manager.stops, 2)
    }
    func testSilentOneShotTimesOutAndNextRequestCanComplete() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager, oneShotTimeout: 1_000_000)
        manager.silent = true
        do { _ = try await service.requestOneShot(userInitiated: false); XCTFail("Silence must be bounded") }
        catch { XCTAssertEqual(error as? AssistantLocationError, .unavailable(.timeout)) }
        manager.silent = false
        let fix = try await service.requestOneShot(userInitiated: false)
        XCTAssertEqual(fix.latitude, 3)
    }

    func testConcurrentOneShotsShareFreshFixAndCaptureID() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.silent = true
        let first = Task { try await service.requestOneShot(userInitiated: false) }
        let second = Task { try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(manager.starts, 1)
        manager.deliver(timestamp: Date())
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.localCaptureID, b.localCaptureID)
    }

    func testSharedFixMustBeNewerThanEachCaller() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.silent = true
        let first = Task { try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<10 { await Task.yield() }
        let earlierSensorTime = Date()
        let second = Task { try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<10 { await Task.yield() }
        manager.deliver(timestamp: earlierSensorTime)
        let fix = try await first.value
        XCTAssertEqual(fix.observedAt, earlierSensorTime)
        manager.deliver(timestamp: Date())
        let later = try await second.value
        XCTAssertGreaterThan(later.observedAt, fix.observedAt)
        XCTAssertEqual(manager.starts, 1)
    }

    func testConcurrentInitialAuthorizationPromptsOnce() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.status = .notDetermined; manager.silent = true
        let first = Task { try await service.requestOneShot(userInitiated: true) }
        let second = Task { try await service.requestOneShot(userInitiated: true) }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(manager.whenInUseRequests, 1)
        manager.status = .authorizedAlways
        manager.delegate?.locationManagerDidChangeAuthorization?(manager)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(manager.starts, 1)
        manager.deliver(timestamp: Date())
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a, b)
    }

    func testCancellingOneCallerPreservesOtherSharedRequest() async throws {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        manager.silent = true
        let first = Task { try await service.requestOneShot(userInitiated: false) }
        let second = Task { try await service.requestOneShot(userInitiated: false) }
        for _ in 0..<10 { await Task.yield() }
        first.cancel()
        do { _ = try await first.value; XCTFail("Cancelled caller must finish") }
        catch { XCTAssertTrue(error is CancellationError) }
        manager.deliver(timestamp: Date())
        let fix = try await second.value
        XCTAssertEqual(fix.latitude, 3)
        XCTAssertEqual(manager.starts, 1)
    }

    func testPlacesDiffReplacesChangedRegionAndStopsWhenDisabled() {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        let original = PlaceRegion(id: "home", label: "Home", latitude: 3, longitude: 4, radius_m: 100)
        service.configurePlaces(enabled: true, regions: [original])
        XCTAssertEqual(manager.startedRegions.count, 1)
        service.configurePlaces(enabled: true, regions: [original])
        XCTAssertEqual(manager.startedRegions.count, 1)
        let moved = PlaceRegion(id: "home", label: "Home", latitude: 5, longitude: 6, radius_m: 200)
        service.configurePlaces(enabled: true, regions: [moved])
        XCTAssertEqual(manager.stoppedRegions.count, 1)
        XCTAssertEqual((manager.startedRegions.last as? CLCircularRegion)?.radius, 200)
        service.configurePlaces(enabled: false, regions: [moved])
        XCTAssertTrue(manager.monitoredRegions.isEmpty)
        XCTAssertEqual(manager.whenInUseRequests, 0)
    }

    func testPlaceRelaunchKeepsOSMonitoringUntilStateIsReadThenEmitsCrossingAtOnce() async {
        let manager = TestLocationManager()
        manager.silent = true
        // The OS restores its own copy of the circle; its centre may differ in the last bits.
        let restored = CLCircularRegion(center: CLLocationCoordinate2D(latitude: 3.000000000001, longitude: 4),
            radius: 100, identifier: "home")
        manager.startMonitoring(for: restored); manager.startedRegions = []
        let service = LocationService(manager: manager)
        var events: [PlaceEvent] = []
        service.onPlaceEvent = { events.append($0) }
        manager.delegate?.locationManagerDidChangeAuthorization?(manager)
        manager.delegate?.locationManager?(manager, didEnterRegion: restored) // Before the first unlock: unreadable.
        for _ in 0..<10 { await Task.yield() }
        XCTAssertTrue(manager.stoppedRegions.isEmpty); XCTAssertTrue(events.isEmpty)
        let region = PlaceRegion(id: "home", label: "Home", latitude: 3, longitude: 4, radius_m: 100)
        service.onPlaceStateNeeded = { service.configurePlaces(enabled: true, regions: [region]) }
        let crossing = Date()
        manager.delegate?.locationManager?(manager, didExitRegion: restored)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertTrue(manager.stoppedRegions.isEmpty); XCTAssertTrue(manager.startedRegions.isEmpty)
        XCTAssertEqual(manager.requestCount, 0, "No fresh fix is awaited")
        XCTAssertEqual(events.map(\.kind), [.regionExit]); XCTAssertEqual(events.first?.regionID, "home")
        XCTAssertEqual(events.first?.location.latitude, 3); XCTAssertEqual(events.first?.location.horizontalAccuracy, 100)
        XCTAssertGreaterThanOrEqual(events.first!.location.observedAt, crossing)
    }

    func testDisabledPlacesDropLateRegionCallback() async {
        let manager = TestLocationManager(), service = LocationService(manager: manager)
        let region = PlaceRegion(id: "home", label: "Home", latitude: 3, longitude: 4, radius_m: 100)
        service.configurePlaces(enabled: true, regions: [region])
        var events: [PlaceEvent] = []
        service.onPlaceEvent = { events.append($0) }
        manager.delegate?.locationManager?(manager, didEnterRegion: manager.startedRegions[0])
        service.configurePlaces(enabled: false, regions: [region])
        for _ in 0..<10 { await Task.yield() }
        XCTAssertTrue(events.isEmpty)
    }

    func testAlwaysPermissionRequiresUserEnablingPlaces() async throws {
        let domain = "places-always-\(UUID())"
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let manager = TestLocationManager()
        let service = LocationService(manager: manager, defaults: defaults, isForeground: { true })
        do { try await service.requestAlwaysAuthorization(userInitiated: true); XCTFail("Places are disabled") }
        catch { XCTAssertEqual(error as? AssistantLocationError, .requestWasNotUserInitiated) }
        service.configurePlaces(enabled: true, regions: [])
        do { try await service.requestAlwaysAuthorization(userInitiated: false); XCTFail("Explicit action required") }
        catch { XCTAssertEqual(error as? AssistantLocationError, .requestWasNotUserInitiated) }
#if os(iOS)
        manager.status = .authorizedWhenInUse
        try await service.requestAlwaysAuthorization(userInitiated: true)
        XCTAssertEqual(manager.alwaysRequests, 1)
#endif
    }

    func testOneShotFailureCarriesTheCoreLocationReason() async {
        for (code, reason) in [(CLError.Code.locationUnknown, AssistantLocationUnavailableReason.timeout),
                               (.network, .network), (.denied, .permissionDenied), (.headingFailure, .failed)] {
            let manager = TestLocationManager(), service = LocationService(manager: manager, oneShotTimeout: 1_000_000)
            manager.failure = code
            do { _ = try await service.requestOneShot(userInitiated: false); XCTFail("The provider failed") }
            catch { XCTAssertEqual(AssistantLocationUnavailableReason(error), reason) }
        }
    }

    func testPermissionStatesMapToTheirOwnReason() {
        XCTAssertNil(AssistantLocationUnavailableReason.blocking(.authorized))
        XCTAssertEqual(AssistantLocationUnavailableReason.blocking(.denied), .permissionDenied)
        XCTAssertEqual(AssistantLocationUnavailableReason.blocking(.restricted), .permissionRestricted)
        XCTAssertEqual(AssistantLocationUnavailableReason.blocking(.notDetermined), .permissionNotDetermined)
        XCTAssertEqual(AssistantLocationUnavailableReason(AssistantLocationError.permissionDenied), .permissionDenied)
    }

    func testAmbientLossReportsWhyTheProviderFailed() async {
        let manager = TestLocationManager(), feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: TestLocationManager()), manager: manager)
        var reasons: [AssistantLocationUnavailableReason?] = []
        let lost = expectation(description: "provider loss")
        lost.expectedFulfillmentCount = 2
        feed.start(consent: 1) { fix, _, reason in if fix == nil { reasons.append(reason); lost.fulfill() } }
        manager.delegate?.locationManager?(manager, didFailWithError: CLError(.network))
        manager.delegate?.locationManager?(manager, didFailWithError: CLError(.locationUnknown))
        await fulfillment(of: [lost], timeout: 1)
        XCTAssertEqual(reasons, [.network, .locationUnknown])
        feed.stop()
    }

    func testFailureWhileBackgroundedUnderWhenInUseSaysSo() async {
        let manager = TestLocationManager(), service = LocationService(manager: manager, oneShotTimeout: 1_000_000, isForeground: { false })
        manager.status = CLAuthorizationStatus(rawValue: 4)!; manager.failure = .locationUnknown
        do { _ = try await service.requestOneShot(userInitiated: false); XCTFail("The provider failed") }
        catch { XCTAssertEqual(AssistantLocationUnavailableReason(error), .backgroundWhenInUse) }
        let always = TestLocationManager(), alwaysService = LocationService(manager: always, oneShotTimeout: 1_000_000, isForeground: { false })
        always.failure = .locationUnknown
        do { _ = try await alwaysService.requestOneShot(userInitiated: false); XCTFail("The provider failed") }
        catch { XCTAssertEqual(AssistantLocationUnavailableReason(error), .timeout) }
        let foreground = TestLocationManager(), foregroundService = LocationService(manager: foreground, oneShotTimeout: 1_000_000, isForeground: { true })
        foreground.status = CLAuthorizationStatus(rawValue: 4)!; foreground.failure = .locationUnknown
        do { _ = try await foregroundService.requestOneShot(userInitiated: false); XCTFail("The provider failed") }
        catch { XCTAssertEqual(AssistantLocationUnavailableReason(error), .timeout) }
    }

    func testAmbientFixWithoutAccuracyReportsInvalidFix() async {
        let manager = TestLocationManager(), feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: TestLocationManager()), manager: manager)
        var reasons: [AssistantLocationUnavailableReason?] = []
        let lost = expectation(description: "unusable fix")
        feed.start(consent: 1) { fix, _, reason in if fix == nil { reasons.append(reason); lost.fulfill() } }
        let unusable = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 3, longitude: 4),
            altitude: 0, horizontalAccuracy: -1, verticalAccuracy: -1, timestamp: Date())
        manager.delegate?.locationManager?(manager, didUpdateLocations: [unusable])
        await fulfillment(of: [lost], timeout: 1)
        XCTAssertEqual(reasons, [.invalidFix])
        feed.stop()
    }

    func testAmbientFailureReportsLossAndRejectsEarlierSensorFix() async {
        let manager = TestLocationManager(), feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: TestLocationManager()), manager: manager)
        var reports: [AssistantLocationObservation?] = []
        let fixed = expectation(description: "sensor fix"), lost = expectation(description: "provider loss")
        lost.expectedFulfillmentCount = 2
        feed.start(consent: 1) { fix, _, _ in
            reports.append(fix)
            if fix == nil { lost.fulfill() } else { fixed.fulfill() }
        }
        manager.requestLocation()
        await fulfillment(of: [fixed], timeout: 1)
        let old = manager.delivered!
        manager.delegate?.locationManager?(manager, didFailWithError: CLError(.locationUnknown))
        manager.delegate?.locationManager?(manager, didFailWithError: CLError(.locationUnknown))
        await fulfillment(of: [lost], timeout: 1)
        XCTAssertNotNil(reports.first!)
        XCTAssertNil(reports.last!)
        XCTAssertEqual(reports.filter { $0 == nil }.count, 2, "Loss remains reportable until a fresh fix recovers")
        let count = reports.count
        manager.delegate?.locationManager?(manager, didUpdateLocations: [old])
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(reports.count, count)
        feed.stop()
    }

    func testStationaryHeartbeatRefreshesSensorTimeWithoutReportingLoss() async {
        let manager = TestLocationManager(), oneShot = TestLocationManager()
        let feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: oneShot), manager: manager)
        manager.cached = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 3, longitude: 4),
            altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: Date(timeIntervalSinceNow: -901))
        var reports: [(AssistantLocationObservation?, Bool)] = []
        let initial = expectation(description: "stationary sensor fix")
        feed.start(consent: 1) { fix, moved, _ in
            reports.append((fix, moved)); if reports.count == 1 { initial.fulfill() }
        }
        manager.requestLocation(); await fulfillment(of: [initial], timeout: 1)
        await feed.sendHeartbeat()
        XCTAssertEqual(reports.count, 2)
        XCTAssertTrue(reports.allSatisfy { $0.0 != nil && $0.1 })
        XCTAssertEqual(reports.last?.0?.observedAt, oneShot.delivered?.timestamp)
        XCTAssertEqual(reports.last?.0?.latitude, reports.first?.0?.latitude)
        XCTAssertNotEqual(reports.last?.0?.observedAt, reports.first?.0?.observedAt)
        feed.stop()
    }

    func testStationaryHeartbeatReportsLossOnceWhenBoundedFixFails() async {
        let manager = TestLocationManager(), oneShot = TestLocationManager()
        oneShot.silent = true
        let feed = AssistantAmbientLocationFeed(locationService: LocationService(manager: oneShot, oneShotTimeout: 1_000_000), manager: manager)
        manager.cached = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 3, longitude: 4),
            altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: Date(timeIntervalSinceNow: -901))
        var reports: [AssistantLocationObservation?] = []
        let initial = expectation(description: "stationary sensor fix")
        feed.start(consent: 1) { fix, _, _ in
            reports.append(fix); if reports.count == 1 { initial.fulfill() }
        }
        manager.requestLocation(); await fulfillment(of: [initial], timeout: 1)
        await feed.sendHeartbeat()
        XCTAssertEqual(reports.count, 2)
        XCTAssertNil(reports.last!)
        feed.stop()
    }
}

private final class BackgroundLocationManagerSpy: AssistantBackgroundLocationManaging {
    let status: CLAuthorizationStatus
    var allowsBackgroundLocationUpdates = false
    var showsBackgroundLocationIndicator = true
    init(status: CLAuthorizationStatus) { self.status = status }
}

private final class TestLocationManager: CLLocationManager {
    var starts = 0, stops = 0, significantStarts = 0, significantStops = 0
    override func startMonitoringSignificantLocationChanges() { significantStarts += 1 }
    override func stopMonitoringSignificantLocationChanges() { significantStops += 1 }
    var silent = false
    var failure: CLError.Code?
    var cached: CLLocation?
    var delivered: CLLocation?
    var status: CLAuthorizationStatus = .authorizedAlways
    var accuracy: CLAccuracyAuthorization = .fullAccuracy
    var requestCount = 0
    var whenInUseRequests = 0
    var onWhenInUseRequest: (() -> Void)?
    var startedRegions: [CLRegion] = []
    var stoppedRegions: [CLRegion] = []
    private var regions: Set<CLRegion> = []
    override var authorizationStatus: CLAuthorizationStatus { status }
    override var accuracyAuthorization: CLAccuracyAuthorization { accuracy }
    override var location: CLLocation? { delivered ?? cached }
    override var monitoredRegions: Set<CLRegion> { regions }
    override func requestWhenInUseAuthorization() { whenInUseRequests += 1; onWhenInUseRequest?() }
    override func startMonitoring(for region: CLRegion) { startedRegions.append(region); regions.insert(region) }
    override func stopMonitoring(for region: CLRegion) { stoppedRegions.append(region); regions.remove(region) }
#if os(iOS)
    var alwaysRequests = 0
    override func requestAlwaysAuthorization() { alwaysRequests += 1 }
    override func startMonitoringVisits() {}
    override func stopMonitoringVisits() {}
#endif
    override func startUpdatingLocation() {
        starts += 1
        if desiredAccuracy == kCLLocationAccuracyBest { emitFix() }
    }
    override func stopUpdatingLocation() { stops += 1 }
    override func requestLocation() {
        requestCount += 1
        emitFix()
    }
    private func emitFix() {
        if let failure { delegate?.locationManager?(self, didFailWithError: CLError(failure)); return }
        guard !silent else { return }
        let fix = cached ?? CLLocation(coordinate: CLLocationCoordinate2D(latitude: 3, longitude: 4),
            altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: Date())
        delivered = fix
        delegate?.locationManager?(self, didUpdateLocations: [fix])
    }
    func deliver(timestamp: Date) {
        let fix = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 3, longitude: 4),
            altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: timestamp)
        delivered = fix
        delegate?.locationManager?(self, didUpdateLocations: [fix])
    }

}

final class MoveSessionTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private func fix(_ seconds: Double, lat: Double = 0, lng: Double = 0, speed: Double? = 20, accuracy: Double = 5) -> MoveFix {
        MoveFix(position: MovePosition(lat: lat, lng: lng, accuracy_m: accuracy), at: start.addingTimeInterval(seconds), speedKmh: speed)
    }
    private func route(revision: Int = 1, mode: String = "bicycling") -> NavRoute {
        NavRoute(nav_id: "nav-1", revision: revision, mode: mode,
            destination: .init(name: "终点", lat: 0.001, lng: 0.001), total_m: 200, total_s: 100,
            steps: [NavStep(index: 0, maneuver: "left", instruction: "左转", road: "甲路", distance_m: 100, duration_s: 50,
                polyline: [.init(lat: 0, lng: 0), .init(lat: 0, lng: 0.001)]),
                NavStep(index: 1, maneuver: "arrive", instruction: "到达", distance_m: 100, duration_s: 50,
                    polyline: [.init(lat: 0, lng: 0.001), .init(lat: 0.001, lng: 0.001)])])
    }
    func testUrbanCanyonDriftDoesNotInflateAverageAboveMaximum() {
        // These coordinate drifts reproduced both reported averages with slower GPS speeds.
        for (drift, speed) in [(23.4, 9.8), (18.0, 6.3)] {
            var statistics = RideStatistics(startedAt: start)
            for second in 0...20 {
                statistics.record(fix(Double(second), lng: Double(second) * (drift / 3.6) / 111_319.49, speed: speed))
            }
            let summary = statistics.summary(at: start.addingTimeInterval(20))
            XCTAssertEqual(summary.distance_m, speed / 3.6 * 20, accuracy: 0.001)
            XCTAssertEqual(summary.avg_kmh, speed, accuracy: 0.001)
            XCTAssertEqual(summary.max_kmh, speed)
            XCTAssertLessThanOrEqual(summary.avg_kmh, summary.max_kmh + 1e-9)
            XCTAssertEqual(statistics.metrics(at: start.addingTimeInterval(20), cadence: nil).avg_kmh, summary.avg_kmh)
        }
    }
    func testInvalidSpeedsFallbackAndPoorAccuracyBreaksIntegration() {
        var statistics = RideStatistics(startedAt: start)
        for (second, speed) in [Double?.none, -1, .nan, .infinity, nil].enumerated() {
            statistics.record(fix(Double(second), lng: Double(second) * 0.00001, speed: speed))
        }
        let fallback = statistics.summary(at: start.addingTimeInterval(4))
        XCTAssertGreaterThan(fallback.distance_m, 4)
        XCTAssertLessThanOrEqual(fallback.avg_kmh, fallback.max_kmh + 0.000001)
        statistics.record(fix(5, lng: 1, speed: 100, accuracy: 100))
        statistics.record(fix(6, lng: 1, speed: 10))
        XCTAssertEqual(statistics.distance, fallback.distance_m)
        statistics.loseFix()
        XCTAssertEqual(statistics.metrics(at: start.addingTimeInterval(20), cadence: nil).speed_kmh, 10)
    }
    func testRetainedSamplesKeepOriginalDatesAndResetForNextRide() throws {
        var session = MoveSession()
        _ = session.startRide(by: "phone", at: start)
        _ = session.observe(fix(0, speed: 10))
        _ = session.observe(fix(1, speed: nil))
        _ = session.watchMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: start, workoutID: "watch",
            heartRateBPM: 140, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil,
            cyclingSpeedMPS: nil, workoutState: .started, heartRateSampleAt: start), at: start)
        session.loseWatch(); session.loseFix()
        guard case .frame(let frame) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(30), cadence: nil)) else { return XCTFail() }
        XCTAssertEqual(frame.ride?.speed_kmh, 10); XCTAssertEqual(frame.ride?.hr_bpm, 140)
        XCTAssertEqual(frame.ride?.speed_sample_at, start); XCTAssertEqual(frame.ride?.hr_sample_at, start)
        _ = session.endRide(at: start.addingTimeInterval(31))
        XCTAssertEqual(session.lastRideState?.state, "ended")
        XCTAssertEqual(session.lastRideState?.summary?.hr_max, 140)
        XCTAssertEqual(session.lastRideWorkoutID, "watch")
        _ = session.startRide(by: "phone", at: start.addingTimeInterval(32))
        XCTAssertEqual(session.lastRideState?.state, "started")
        XCTAssertNil(session.lastRideWorkoutID)
        guard case .frame(let next) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(33), cadence: nil)) else { return XCTFail() }
        XCTAssertNil(next.ride?.speed_kmh); XCTAssertNil(next.ride?.hr_bpm)
        XCTAssertNil(next.ride?.speed_sample_at); XCTAssertNil(next.ride?.hr_sample_at)
    }
    func testSingleSpeedSpikeCannotSetMaximum() {
        var statistics = RideStatistics(startedAt: start)
        for (i, speed) in [20.0, 20, 180, 20, 20].enumerated() { statistics.record(fix(Double(i), speed: speed)) }
        XCTAssertEqual(statistics.summary(at: start.addingTimeInterval(5)).max_kmh, 20)
    }
    func testStoppedTimeDoesNotDiluteAverage() {
        var statistics = RideStatistics(startedAt: start)
        for second in 0...17 {
            let movingSeconds = min(second, 5) + max(0, second - 16)
            statistics.record(fix(Double(second), lng: Double(movingSeconds) * 5.55556 / 111_319.49,
                speed: second < 5 || second >= 16 ? 20 : 0))
        }
        let summary = statistics.summary(at: start.addingTimeInterval(17))
        XCTAssertEqual(summary.moving_s, 6)
        XCTAssertEqual(summary.elapsed_s, 17)
        XCTAssertEqual(summary.avg_kmh, 20, accuracy: 0.1)
    }
    func testSlowMovementStillCountsDistanceAndWatchAverageIsTimeWeighted() throws {
        var statistics = RideStatistics(startedAt: start)
        statistics.record(fix(0, speed: 2)); statistics.record(fix(1, lng: 0.00001, speed: 2))
        XCTAssertEqual(statistics.summary(at: start.addingTimeInterval(1)).distance_m, 2 / 3.6, accuracy: 0.001)
        XCTAssertEqual(statistics.summary(at: start.addingTimeInterval(1)).moving_s, 0)
        for time in [0.0, 2, 3, 4, 5] {
            statistics.recordWatch(WatchCyclingMetricEnvelope(sequence: UInt64(time + 1), observedAt: start.addingTimeInterval(time), workoutID: "watch-1",
                heartRateBPM: time == 0 ? 100 : 200, activeEnergyKcal: 10, distanceM: nil, elapsedS: time, cadenceSPM: nil, cyclingSpeedMPS: nil))
        }
        XCTAssertEqual(try XCTUnwrap(statistics.summary(at: start.addingTimeInterval(6)).hr_avg), 500 / 3, accuracy: 0.01)
        statistics.loseWatch()
        XCTAssertEqual(statistics.metrics(at: start.addingTimeInterval(6), cadence: nil).hr_bpm, 200)
        XCTAssertNil(statistics.metrics(at: start.addingTimeInterval(6), cadence: nil).kcal)
    }
    func testEnergyCallbacksCannotReweightAnUnchangedHeartSample() throws {
        var statistics = RideStatistics(startedAt: start)
        for second in 0...12 {
            statistics.recordWatch(WatchCyclingMetricEnvelope(
                sequence: UInt64(second + 1), observedAt: start.addingTimeInterval(Double(second)),
                workoutID: "watch", heartRateBPM: second <= 5 ? 100 : nil,
                activeEnergyKcal: Double(second), distanceM: nil, elapsedS: Double(second),
                cadenceSPM: nil, cyclingSpeedMPS: nil, heartRateSampleAt: second <= 5 ? start : nil))
            if second == 5 {
                XCTAssertEqual(statistics.metrics(at: start.addingTimeInterval(5), cadence: nil).hr_bpm, 100)
                XCTAssertEqual(statistics.metrics(at: start.addingTimeInterval(5.001), cadence: nil).hr_bpm, 100)
            }
        }
        XCTAssertEqual(statistics.metrics(at: start.addingTimeInterval(12), cadence: nil).kcal, 12)
        statistics.recordWatch(WatchCyclingMetricEnvelope(
            sequence: 14, observedAt: start.addingTimeInterval(20), workoutID: "watch",
            heartRateBPM: 200, activeEnergyKcal: 20, distanceM: nil, elapsedS: 20,
            cadenceSPM: nil, cyclingSpeedMPS: nil, heartRateSampleAt: start.addingTimeInterval(20)))
        XCTAssertEqual(try XCTUnwrap(statistics.summary(at: start.addingTimeInterval(25)).hr_avg), 150)
        XCTAssertEqual(statistics.summary(at: start.addingTimeInterval(25)).hr_max, 200)
    }

    func testMetricSampleDatesRoundTripAndStrictlyValidateWithoutBreakingOldPackets() throws {
        func metric(sampleAt: Date?) -> WatchCyclingMetricEnvelope {
            WatchCyclingMetricEnvelope(
                sequence: 1, observedAt: start.addingTimeInterval(5), workoutID: "watch",
                heartRateBPM: 140, activeEnergyKcal: 2, distanceM: 3, elapsedS: 5,
                cadenceSPM: nil, cyclingSpeedMPS: nil, heartRateSampleAt: sampleAt)
        }
        let dated = metric(sampleAt: start)
        XCTAssertEqual(try WatchCyclingMetricEnvelope.decodeStrict(dated.encodedStrict()), dated)
        let legacy = metric(sampleAt: nil)
        XCTAssertEqual(try WatchCyclingMetricEnvelope.decodeStrict(legacy.encodedStrict()), legacy)
        for invalidDate in [start.addingTimeInterval(5.001)] {
            XCTAssertThrowsError(try metric(sampleAt: invalidDate).encodedStrict())
            var wire = try XCTUnwrap(JSONSerialization.jsonObject(with: dated.encodedStrict()) as? [String: Any])
            // Preserve milliseconds so a date just beyond the boundary remains invalid on the wire.
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            wire["heart_rate_sample_at"] = formatter.string(from: invalidDate)
            XCTAssertThrowsError(try WatchCyclingMetricEnvelope.decodeStrict(JSONSerialization.data(withJSONObject: wire)))
        }
    }

    func testPocketCadenceFindsNoisyEightyRPMAndRejectsNoiseAndSlowSpeed() throws {
        var periodic = PocketCadenceEstimator(), noiseOnly = PocketCadenceEstimator(), seed: UInt64 = 42
        for i in 0...300 {
            seed = seed &* 6364136223846793005 &+ 1
            let noise = Double(seed >> 32) / Double(UInt32.max) - 0.5, time = Double(i) / 50
            periodic.sample(at: time, x: sin(time * 2 * .pi * 80 / 60) + noise * 0.3, y: noise * 0.1, z: 0)
            noiseOnly.sample(at: time, x: noise, y: 0, z: 0)
        }
        XCTAssertEqual(try XCTUnwrap(periodic.estimate(speedKmh: 20, at: 6)), 80, accuracy: 2)
        XCTAssertNil(noiseOnly.estimate(speedKmh: 20, at: 6))
        XCTAssertNil(periodic.estimate(speedKmh: 5, at: 6))
    }
    func testNavigationProjectsOntoStepsAndScalesRemainingTime() throws {
        var follower = NavigationFollower(route: route())
        XCTAssertNil(follower.update(fix(0, lng: 0.0005)))
        var progress = try XCTUnwrap(follower.progress)
        XCTAssertEqual(progress.step_index, 0)
        XCTAssertEqual(progress.distance_to_maneuver_m, 50, accuracy: 0.1)
        XCTAssertEqual(progress.remaining_m, 150, accuracy: 0.1)
        XCTAssertEqual(progress.remaining_s, 75, accuracy: 0.1)
        XCTAssertEqual(progress.route_segment_index, 0)
        XCTAssertEqual(progress.segment_fraction, 0.5, accuracy: 0.001)
        XCTAssertNil(follower.update(fix(1, lat: 0.0005, lng: 0.001)))
        progress = try XCTUnwrap(follower.progress)
        XCTAssertEqual(progress.step_index, 1)
        XCTAssertEqual(progress.route_segment_index, 2)
        XCTAssertEqual(progress.segment_fraction, 0.5, accuracy: 0.001)
        XCTAssertEqual(progress.distance_to_maneuver_m, 50, accuracy: 0.1)
    }
    func testOffRouteNeedsThreeGoodFixesAndOnlyReportsOncePerRevision() throws {
        var session = MoveSession()
        _ = session.follow(route(), at: start)
        XCTAssertTrue(session.observe(fix(0, lat: -0.001)).isEmpty)
        XCTAssertTrue(session.observe(fix(1, lat: -0.001)).isEmpty)
        XCTAssertTrue(session.observe(fix(2, lat: -0.001, accuracy: 21)).isEmpty)
        XCTAssertTrue(session.observe(fix(3, lat: -0.001)).isEmpty)
        XCTAssertTrue(session.observe(fix(4, lat: -0.001)).isEmpty)
        let events = session.observe(fix(5, lat: -0.001))
        guard case .navState(let state) = try XCTUnwrap(events.first) else { return XCTFail("Expected off_route") }
        XCTAssertEqual(state.state, "off_route")
        XCTAssertTrue(session.observe(fix(6, lat: -0.001)).isEmpty)
        _ = session.follow(route(revision: 2), at: start.addingTimeInterval(7))
        XCTAssertTrue(session.observe(fix(7, lat: -0.001)).isEmpty)
        XCTAssertTrue(session.observe(fix(8, lat: -0.001)).isEmpty)
        XCTAssertEqual(session.observe(fix(9, lat: -0.001)).count, 1)
    }
    func testArrivalEndsNavigationAndKeepsRideWhileWalkingNeedsNoRide() throws {
        var session = MoveSession()
        _ = session.startRide(by: "voice", at: start); _ = session.follow(route(), at: start)
        let events = session.observe(fix(1, lat: 0.00095, lng: 0.001))
        guard case .navState(let state) = try XCTUnwrap(events.first) else { return XCTFail("Expected arrival") }
        XCTAssertEqual(state.state, "arrived")
        let wire = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(XCTUnwrap(session.frame(at: start.addingTimeInterval(1), cadence: nil)))) as! [String: Any]
        XCTAssertNotNil(wire["ride"]); XCTAssertNil(wire["nav"])
        _ = session.endRide(at: start.addingTimeInterval(2))
        XCTAssertFalse(session.isActive)
        _ = session.follow(route(mode: "walking"), at: start.addingTimeInterval(3))
        _ = session.observe(fix(3, lng: 0.0005, speed: 4))
        let walk = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(XCTUnwrap(session.frame(at: start.addingTimeInterval(3), cadence: nil)))) as! [String: Any]
        XCTAssertNil(walk["ride"]); XCTAssertNil(walk["ride_id"]); XCTAssertNotNil(walk["nav"])
        _ = session.stopNavigation(at: start.addingTimeInterval(4)); XCTAssertFalse(session.isActive)
    }
    func testHeldNavigationFixRetainsSampleTime() throws {
        var session = MoveSession()
        _ = session.follow(route(), at: start)
        _ = session.observe(fix(1, lng: 0.0005))
        guard case .frame(let frame) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(4), cadence: nil)) else { return XCTFail() }
        XCTAssertEqual(frame.position?.at, start.addingTimeInterval(1))
        XCTAssertEqual(frame.at, start.addingTimeInterval(4))
    }
    func testWatchLifecycleAndMoveWireKeysOmitUnknownValues() throws {
        var session = MoveSession()
        let incoming = WatchCyclingMetricEnvelope(sequence: 1, observedAt: start.addingTimeInterval(0.123), workoutID: "watch-1",
            heartRateBPM: 140, activeEnergyKcal: 12, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch)
        let decoded = try WatchCyclingMetricEnvelope.decodeStrict(incoming.encodedStrict())
        XCTAssertEqual(decoded.observedAt.timeIntervalSince(start), 0.123, accuracy: 0.001)
        XCTAssertEqual(decoded.workoutOrigin, .watch)
        let started = session.watchMetric(decoded, at: decoded.observedAt)
        let state = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(XCTUnwrap(started.first))) as! [String: Any]
        XCTAssertEqual(Set(state.keys), Set(["operation", "ride_id", "state", "at", "started_by"]))
        XCTAssertEqual(state["started_by"] as? String, "watch")
        _ = session.follow(route(), at: start); _ = session.observe(fix(1, lng: 0.0005))
        let frame = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(XCTUnwrap(session.frame(at: start.addingTimeInterval(1), cadence: 80)))) as! [String: Any]
        XCTAssertEqual(Set(frame.keys), Set(["operation", "ride_id", "nav_id", "seq", "at", "position", "ride", "nav"]))
        XCTAssertEqual(Set((frame["position"] as! [String: Any]).keys), Set(["lat", "lng", "accuracy_m", "at"]))
        XCTAssertEqual(Set((frame["ride"] as! [String: Any]).keys), Set(["speed_kmh", "avg_kmh", "max_kmh", "distance_m", "moving_s", "elapsed_s", "hr_bpm", "hr_sample_at", "speed_sample_at", "kcal", "cadence_rpm", "cadence_source"]))
        XCTAssertEqual(Set((frame["nav"] as! [String: Any]).keys), Set(["nav_id", "revision", "step_index", "maneuver", "distance_to_maneuver_m", "road", "remaining_m", "remaining_s", "route_segment_index", "segment_fraction"]))
        let ended = session.watchMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: start.addingTimeInterval(2), workoutID: "watch-1",
            heartRateBPM: nil, activeEnergyKcal: 13, distanceM: nil, elapsedS: 2, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended), at: start.addingTimeInterval(2))
        let end = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(XCTUnwrap(ended.first))) as! [String: Any]
        XCTAssertEqual(Set(end.keys), Set(["operation", "ride_id", "state", "at", "started_by", "summary"]))
        XCTAssertEqual(Set((end["summary"] as! [String: Any]).keys), Set(["started_at", "ended_at", "distance_m", "moving_s", "elapsed_s", "avg_kmh", "max_kmh", "kcal", "hr_avg", "hr_max"]))
        let nav = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(XCTUnwrap(session.observe(fix(3, lat: 0.001, lng: 0.001)).first))) as! [String: Any]
        XCTAssertEqual(Set(nav.keys), Set(["operation", "nav_id", "state", "at", "position"]))
        XCTAssertEqual(Set((nav["position"] as! [String: Any]).keys), Set(["lat", "lng"]))
        XCTAssertNil(session.frame(at: start.addingTimeInterval(4), cadence: nil))
    }
    func testFramesKeepWatchAndElapsedLiveBeforeFirstFixAndDuringGPSLoss() throws {
        var session = MoveSession()
        _ = session.startRide(by: "phone", at: start)
        _ = session.follow(route(), at: start)
        var previousDistance = 0.0
        for second in 1...10 {
            if second == 3 || second == 4 || second == 10 { _ = session.observe(fix(Double(second), lng: Double(second) * 0.00001)) }
            if second == 5 { session.loseFix() }
            _ = session.watchMetric(WatchCyclingMetricEnvelope(sequence: UInt64(second), observedAt: start.addingTimeInterval(Double(second)), workoutID: "watch-1",
                heartRateBPM: Double(140 + second), activeEnergyKcal: Double(second), distanceM: nil, elapsedS: Double(second), cadenceSPM: nil, cyclingSpeedMPS: nil,
                workoutState: second == 1 ? .started : nil, workoutOrigin: .phone), at: start.addingTimeInterval(Double(second)))
            guard case .frame(let frame) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(Double(second)), cadence: 80)) else { return XCTFail("Expected ride frame") }
            XCTAssertEqual(frame.seq, second)
            let ride = try XCTUnwrap(frame.ride)
            XCTAssertEqual(ride.elapsed_s, Double(second))
            XCTAssertEqual(ride.hr_bpm, Double(140 + second))
            if (3...4).contains(second) || second == 10 {
                XCTAssertNotNil(frame.position); XCTAssertEqual(ride.speed_kmh, 20)
                XCTAssertNotNil(frame.nav)
                if second == 10 { XCTAssertEqual(ride.distance_m, previousDistance) }
            } else {
                let wire = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.move(.frame(frame))) as! [String: Any]
                let metrics = try XCTUnwrap(wire["ride"] as? [String: Any])
                XCTAssertNil(wire["position"]); XCTAssertNil(wire["nav"])
                if second < 3 { XCTAssertNil(metrics["speed_kmh"]) }
                else { XCTAssertEqual(metrics["speed_kmh"] as? Double, 20) }
                XCTAssertNil(metrics["cadence_rpm"]); XCTAssertNil(metrics["cadence_source"])
                XCTAssertEqual(ride.distance_m, previousDistance)
            }
            previousDistance = ride.distance_m
        }
        // An expired fix has the same missing-position contract, without a sensor failure callback.
        guard case .frame(let expired) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(16), cadence: 80)) else { return XCTFail("Expected expired-fix frame") }
        XCTAssertEqual(expired.seq, 11); XCTAssertNil(expired.position); XCTAssertNil(expired.nav)
        XCTAssertEqual(expired.ride?.elapsed_s, 16); XCTAssertEqual(expired.ride?.distance_m, previousDistance)
        XCTAssertEqual(expired.ride?.speed_kmh, 20); XCTAssertEqual(expired.ride?.hr_bpm, 150); XCTAssertNil(expired.ride?.kcal)
        _ = session.endRide(at: start.addingTimeInterval(17))
        guard case .frame(let navigationOnly) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(17), cadence: nil)) else { return XCTFail("Expected navigation frame") }
        XCTAssertEqual(navigationOnly.seq, 12); XCTAssertEqual(navigationOnly.nav_id, "nav-1")
        XCTAssertNil(navigationOnly.ride); XCTAssertNil(navigationOnly.position); XCTAssertNil(navigationOnly.nav)
        _ = session.stopNavigation(at: start.addingTimeInterval(17))
        XCTAssertNil(session.frame(at: start.addingTimeInterval(18), cadence: nil))
    }
    func testHistoricalWatchWorkoutCannotEndNewerPhoneRide() throws {
        var session = MoveSession()
        _ = session.startRide(by: "voice", at: start.addingTimeInterval(-5)); _ = session.endRide(at: start.addingTimeInterval(3))
        _ = session.startRide(by: "voice", at: start.addingTimeInterval(5))
        let old = WatchCyclingMetricEnvelope(sequence: 1, observedAt: start, workoutID: "old-watch",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started)
        XCTAssertTrue(session.watchMetric(old, at: start.addingTimeInterval(6)).isEmpty)
        XCTAssertTrue(session.watchMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: start.addingTimeInterval(6), workoutID: "old-watch",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 6, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended), at: start.addingTimeInterval(7)).isEmpty)
        _ = session.watchMetric(WatchCyclingMetricEnvelope(sequence: 3, observedAt: start.addingTimeInterval(7), workoutID: "new-watch",
            heartRateBPM: 145, activeEnergyKcal: 12, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .phone), at: start.addingTimeInterval(7))
        for second in 5...11 { _ = session.observe(fix(Double(second))) }
        guard case .frame(let frame) = try XCTUnwrap(session.frame(at: start.addingTimeInterval(11), cadence: nil)) else { return XCTFail("Expected ride frame") }
        XCTAssertEqual(frame.ride?.hr_bpm, 145)
        XCTAssertEqual(frame.ride?.elapsed_s, 6)
        let ended = session.watchMetric(WatchCyclingMetricEnvelope(sequence: 4, observedAt: start.addingTimeInterval(8), workoutID: "new-watch",
            heartRateBPM: nil, activeEnergyKcal: 13, distanceM: nil, elapsedS: 1, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended), at: start.addingTimeInterval(12))
        guard case .rideState(let state) = try XCTUnwrap(ended.first) else { return XCTFail("Expected ride end") }
        XCTAssertEqual(state.summary?.ended_at, start.addingTimeInterval(12))
        XCTAssertEqual(state.summary?.moving_s, 6); XCTAssertEqual(state.summary?.elapsed_s, 7)
        XCTAssertEqual(session.watchMetric(WatchCyclingMetricEnvelope(sequence: 5, observedAt: start.addingTimeInterval(9), workoutID: "next-watch",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch), at: start.addingTimeInterval(13)).count, 1)
    }
}
