import CoreLocation
import CoreMotion
import ExpoModulesCore
import Foundation
import UIKit
import UserNotifications

private enum ArrivalDiagnosticConstants {
  static let schemaVersion = 3
  static let previousSchemaVersion = 2
  static let regionLimit = 20
  static let maximumEvents = 512
  static let observationDurationSeconds = 240.0
  static let migratedBurstDurationSeconds = 45.0
  static let driveAwayMinimumDistanceMeters = 125.0
  static let driveAwayDistanceIncreaseMeters = 50.0
  static let driveAwayMinimumSpeedMetersPerSecond = 4.0
  static let driveAwayMaximumHorizontalAccuracyMeters = 15.0
  static let driveAwayMaximumSpeedAccuracyMetersPerSecond = 1.0
  static let freshLocationMaximumAgeSeconds = 15.0
  static let inferredCallbackGapMinimumSeconds = 10.0
  static let historicalLookbackSeconds = 120.0
  static let maximumHistoricalActivities = 16
  static let historicalQueryMaximumSeconds = 30.0 * 60.0
  static let regionIdentifier = "tyg.diagnostic.arrival.v1.trader-joes-119"
  static let regionIdentifierPrefix = "tyg.diagnostic.arrival.v1."
  static let storeIdentifier = "trader-joes-119"
  static let storeName = "Trader Joe's"
  static let latitude = 34.0203234
  static let longitude = -118.4220680
  static let radiusMeters = 75.0
  static let radiusToleranceMeters = 0.01
  static let userDefaultsKey = "there-you-go.arrival-diagnostic.state.v1"
}

private struct PersistedArrivalDiagnosticEvent: Codable {
  let sequence: Int
  let type: String
  let recordedAt: String
  let appState: String
  let detail: String?
  let locationTimestamp: String?
  let horizontalAccuracyMeters: Double?
  let speedMetersPerSecond: Double?
  let speedAccuracyMetersPerSecond: Double?
  let distanceFromStoreMeters: Double?
  let sampleAgeSeconds: Double?
  let isFreshLocation: Bool?
  let executionDurationSeconds: Double?
  let activityStartTimestamp: String?
  let activityAutomotive: Bool?
  let activityStationary: Bool?
  let activityWalking: Bool?
  let activityRunning: Bool?
  let activityUnknown: Bool?
  let activityCycling: Bool?
  let activityConfidence: String?
  let observationIdentifier: String?
}

private struct PersistedArrivalDiagnosticStateV2: Codable {
  let schemaVersion: Int
  var isArmed: Bool
  var activeBurstStartedAt: String?
  var events: [PersistedArrivalDiagnosticEvent]
}

private struct PersistedArrivalDiagnosticState: Codable {
  var schemaVersion: Int
  var isArmed: Bool
  var activeObservationIdentifier: String?
  var observationStartedAt: String?
  var observationDeadline: String?
  var lastLiveUpdateReceivedAt: String?
  var lastObservedCallbackAt: String?
  var events: [PersistedArrivalDiagnosticEvent]

  static var empty: PersistedArrivalDiagnosticState {
    PersistedArrivalDiagnosticState(
      schemaVersion: ArrivalDiagnosticConstants.schemaVersion,
      isArmed: false,
      activeObservationIdentifier: nil,
      observationStartedAt: nil,
      observationDeadline: nil,
      lastLiveUpdateReceivedAt: nil,
      lastObservedCallbackAt: nil,
      events: []
    )
  }
}

private struct LoadedArrivalDiagnosticState {
  let state: PersistedArrivalDiagnosticState
  let migratedFromV2: Bool
  let persistenceBlocked: Bool
}

struct ArrivalDiagnosticEventRecord: Record {
  @Field var sequence: Int = 0
  @Field var type: String = ""
  @Field var recordedAt: String = ""
  @Field var appState: String = ""
  @Field var detail: String? = nil
  @Field var locationTimestamp: String? = nil
  @Field var horizontalAccuracyMeters: Double? = nil
  @Field var speedMetersPerSecond: Double? = nil
  @Field var speedAccuracyMetersPerSecond: Double? = nil
  @Field var distanceFromStoreMeters: Double? = nil
  @Field var sampleAgeSeconds: Double? = nil
  @Field var isFreshLocation: Bool? = nil
  @Field var executionDurationSeconds: Double? = nil
  @Field var activityStartTimestamp: String? = nil
  @Field var activityAutomotive: Bool? = nil
  @Field var activityStationary: Bool? = nil
  @Field var activityWalking: Bool? = nil
  @Field var activityRunning: Bool? = nil
  @Field var activityUnknown: Bool? = nil
  @Field var activityCycling: Bool? = nil
  @Field var activityConfidence: String? = nil
  @Field var observationIdentifier: String? = nil
}

struct ArrivalDiagnosticStatusRecord: Record {
  @Field var buildEnabled: Bool = false
  @Field var isArmed: Bool = false
  @Field var authorizationStatus: String = ""
  @Field var accuracyAuthorization: String = ""
  @Field var backgroundRefreshStatus: String = ""
  @Field var backgroundModeEnabled: Bool = false
  @Field var regionMonitoringAvailable: Bool = false
  @Field var diagnosticRegionRegistered: Bool = false
  @Field var serviceSessionSupported: Bool = false
  @Field var serviceSessionActive: Bool = false
  @Field var liveUpdatesSupported: Bool = false
  @Field var observationActive: Bool = false
  @Field var observationDeadline: String? = nil
  @Field var observationDurationSeconds: Double =
    ArrivalDiagnosticConstants.observationDurationSeconds
  // Kept for compatibility with the existing diagnostic console contract.
  @Field var burstActive: Bool = false
  @Field var pendingLocationNotificationCount: Int = 0
  @Field var monitoredRegionCount: Int = 0
  @Field var conservativeOccupiedRegionCount: Int = 0
  @Field var regionLimit: Int = ArrivalDiagnosticConstants.regionLimit
  @Field var storeIdentifier: String = ArrivalDiagnosticConstants.storeIdentifier
  @Field var storeName: String = ArrivalDiagnosticConstants.storeName
  @Field var latitude: Double = ArrivalDiagnosticConstants.latitude
  @Field var longitude: Double = ArrivalDiagnosticConstants.longitude
  @Field var radiusMeters: Double = ArrivalDiagnosticConstants.radiusMeters
  @Field var burstDurationSeconds: Double =
    ArrivalDiagnosticConstants.observationDurationSeconds
  @Field var motionAvailable: Bool = false
  @Field var motionAuthorizationStatus: String = ""
}

struct ArrivalDiagnosticResultsRecord: Record {
  @Field var schemaVersion: Int = ArrivalDiagnosticConstants.schemaVersion
  @Field var storeIdentifier: String = ArrivalDiagnosticConstants.storeIdentifier
  @Field var storeName: String = ArrivalDiagnosticConstants.storeName
  @Field var radiusMeters: Double = ArrivalDiagnosticConstants.radiusMeters
  @Field var isArmed: Bool = false
  @Field var events: [ArrivalDiagnosticEventRecord] = []
}

struct ArrivalDiagnosticActivitySampleRecord: Record {
  @Field var activityStartTimestamp: String = ""
  @Field var automotive: Bool = false
  @Field var stationary: Bool = false
  @Field var walking: Bool = false
  @Field var running: Bool = false
  @Field var cycling: Bool = false
  @Field var unknown: Bool = false
  @Field var confidence: String = ""
}

struct ArrivalDiagnosticHistoryQueryRecord: Record {
  @Field var outcome: String = ""
  @Field var from: String = ""
  @Field var to: String = ""
  @Field var detail: String? = nil
  @Field var activities: [ArrivalDiagnosticActivitySampleRecord] = []
}

private enum ArrivalDiagnosticError: LocalizedError {
  case disabledBuild
  case unsupportedOperatingSystem
  case foregroundRequired
  case persistedStateUnreadable
  case locationServicesDisabled
  case monitoringUnavailable
  case backgroundModeMissing
  case backgroundRefreshUnavailable
  case alwaysAuthorizationDenied
  case preciseLocationRequired
  case radiusUnsupported
  case regionCapacity(Int)
  case invalidHistoryWindow(String)
  case motionUnavailable
  case motionAuthorizationRequired(String)
  case motionQueryFailed(String)

  var errorDescription: String? {
    switch self {
    case .disabledBuild:
      return "The arrival diagnostic is disabled in this build."
    case .unsupportedOperatingSystem:
      return "The arrival lifecycle diagnostic requires iOS 18 or later."
    case .foregroundRequired:
      return "Arm the arrival lifecycle diagnostic while the app is active in the foreground."
    case .persistedStateUnreadable:
      return "Existing arrival diagnostic history could not be migrated safely, so arming was refused without changing it."
    case .locationServicesDisabled:
      return "Location Services are disabled on this iPhone."
    case .monitoringUnavailable:
      return "Circular region monitoring is unavailable on this iPhone."
    case .backgroundModeMissing:
      return "This build does not include the iOS Location Updates background mode."
    case .backgroundRefreshUnavailable:
      return "Background App Refresh must be enabled for the arrival diagnostic."
    case .alwaysAuthorizationDenied:
      return "Always location access is required for suspended or terminated-app testing."
    case .preciseLocationRequired:
      return "Precise Location must be enabled for useful arrival-distance diagnostics."
    case .radiusUnsupported:
      return "The test device does not support the diagnostic's 75-meter region."
    case .regionCapacity(let count):
      return "The diagnostic was not armed because \(count) of 20 conservative region slots are already occupied."
    case .invalidHistoryWindow(let message):
      return message
    case .motionUnavailable:
      return "Motion activity history is unavailable on this iPhone."
    case .motionAuthorizationRequired(let status):
      return "Motion & Fitness access is required to query activity history (status: \(status))."
    case .motionQueryFailed(let detail):
      return "Core Motion activity history query failed (\(detail))."
    }
  }
}

private enum HistoricalActivityFetch {
  case samples([CMMotionActivity])
  case noSamples(String)
  case failure(ArrivalDiagnosticError)
}

/// `CMError` values from CoreMotion `CMError.h`, where `CMErrorNULL` is 100.
private enum CoreMotionHistoryErrorCode {
  static let unknown = 103
  static let motionActivityNotAvailable = 104
  static let motionActivityNotAuthorized = 105
  static let notAvailable = 109
  static let notAuthorized = 111
}

@available(iOS 18.0, *)
private final class ArrivalDiagnosticModernRuntime {
  var serviceSession: CLServiceSession?
  var serviceDiagnosticsTask: Task<Void, Never>?
  var liveUpdatesTask: Task<Void, Never>?
}

@MainActor
final class ThereYouGoArrivalDiagnostic:
  NSObject, @preconcurrency CLLocationManagerDelegate
{
  static let shared = ThereYouGoArrivalDiagnostic()

  private let decoder = JSONDecoder()
  private let encoder: JSONEncoder
  private let motionCallbackQueue = OperationQueue()
  private var locationManager: CLLocationManager?
  private var motionManager: CMMotionActivityManager?
  private var state: PersistedArrivalDiagnosticState
  private var modernRuntime: AnyObject?
  private var observationDeadlineTask: Task<Void, Never>?
  private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
  private var motionUpdatesActive = false
  private var recordedActivityKeys = Set<String>()
  private var persistenceBlocked = false

  private override init() {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    self.encoder = encoder
    let loaded = Self.loadState(decoder: decoder)
    self.state = loaded.state
    self.persistenceBlocked = loaded.persistenceBlocked
    super.init()
    if loaded.migratedFromV2 {
      appendEvent(
        type: "diagnostic-state-migrated",
        detail: "v2-to-v3-all-events-preserved"
      )
    }
  }

  func handleLaunch(launchedForLocation: Bool) {
    if !buildEnabled {
      guard state.isArmed || state.activeObservationIdentifier != nil else {
        return
      }
      ensureLocationManager()
      stopDiagnosticRegions()
      terminateObservation(reason: "diagnostic-disabled")
      invalidateServiceSession()
      state.isArmed = false
      appendEvent(
        type: "diagnostic-disabled",
        detail: "A default build removed persisted diagnostic activity."
      )
      return
    }

    guard state.isArmed else {
      ensureLocationManager()
      stopStaleDiagnosticRegions()
      return
    }

    if #available(iOS 18.0, *) {
      establishServiceSession(
        origin: launchedForLocation
          ? "location-launch-reconstruction"
          : "normal-launch-reconstruction",
        reconstructed: true
      )
    }
    ensureLocationManager()
    appendEvent(
      type: "observed-process-launch",
      detail: "launchOptionsLocationKey=\(launchedForLocation)"
    )
    stopStaleDiagnosticRegions()
    locationManager?.startMonitoring(for: diagnosticRegion())
    guard
      !terminateIfDeadlineExpired(reason: "deadline-detected-on-launch")
    else {
      return
    }
    reconstructObservationIfNeeded()
  }

  func arm() async throws -> ArrivalDiagnosticStatusRecord {
    guard buildEnabled else {
      throw ArrivalDiagnosticError.disabledBuild
    }
    guard #available(iOS 18.0, *) else {
      throw ArrivalDiagnosticError.unsupportedOperatingSystem
    }
    guard UIApplication.shared.applicationState == .active else {
      throw ArrivalDiagnosticError.foregroundRequired
    }
    guard !persistenceBlocked else {
      throw ArrivalDiagnosticError.persistedStateUnreadable
    }
    guard backgroundModeEnabled else {
      throw ArrivalDiagnosticError.backgroundModeMissing
    }
    guard UIApplication.shared.backgroundRefreshStatus == .available else {
      throw ArrivalDiagnosticError.backgroundRefreshUnavailable
    }
    guard CLLocationManager.locationServicesEnabled() else {
      throw ArrivalDiagnosticError.locationServicesDisabled
    }
    guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else {
      throw ArrivalDiagnosticError.monitoringUnavailable
    }

    ensureLocationManager()
    guard
      let locationManager,
      locationManager.maximumRegionMonitoringDistance >=
        ArrivalDiagnosticConstants.radiusMeters
    else {
      throw ArrivalDiagnosticError.radiusUnsupported
    }

    switch locationManager.authorizationStatus {
    case .notDetermined, .authorizedWhenInUse:
      appendEvent(
        type: "always-permission-requested",
        detail: authorizationStatusName(locationManager.authorizationStatus)
      )
      locationManager.requestAlwaysAuthorization()
      await prepareMotionAccess()
      return await makeStatus()
    case .denied, .restricted:
      throw ArrivalDiagnosticError.alwaysAuthorizationDenied
    case .authorizedAlways:
      break
    @unknown default:
      throw ArrivalDiagnosticError.alwaysAuthorizationDenied
    }

    guard locationManager.accuracyAuthorization == .fullAccuracy else {
      throw ArrivalDiagnosticError.preciseLocationRequired
    }

    let pendingRequests =
      await UNUserNotificationCenter.current().pendingNotificationRequests()
    let occupancy = conservativeOccupiedRegionIdentifiers(
      pendingRequests: pendingRequests
    )
    let replaceableDiagnosticCount = occupancy.filter(isDiagnosticRegionIdentifier).count
    let occupiedAfterArm =
      occupancy.count + (replaceableDiagnosticCount > 0 ? 0 : 1)
    guard occupiedAfterArm <= ArrivalDiagnosticConstants.regionLimit else {
      appendEvent(
        type: "arm-refused-region-capacity",
        detail: "\(occupancy.count)-occupied"
      )
      throw ArrivalDiagnosticError.regionCapacity(occupancy.count)
    }

    state.isArmed = true
    establishServiceSession(origin: "foreground-arm", reconstructed: false)
    stopDiagnosticRegions()
    appendEvent(
      type: "diagnostic-armed",
      detail: "\(occupancy.count)-occupied-before-arm"
    )
    locationManager.startMonitoring(for: diagnosticRegion())
    await prepareMotionAccess()
    return await makeStatus()
  }

  func disable() async -> ArrivalDiagnosticStatusRecord {
    ensureLocationManager()
    terminateObservation(reason: "diagnostic-disabled")
    stopMotionUpdates(logEvent: false)
    stopDiagnosticRegions()
    state.isArmed = false
    invalidateServiceSession()
    appendEvent(type: "diagnostic-disabled", detail: "explicit-cleanup")
    return await makeStatus()
  }

  func clearResults() {
    state.events = []
    saveState()
  }

  func results() -> ArrivalDiagnosticResultsRecord {
    let record = ArrivalDiagnosticResultsRecord()
    record.isArmed = state.isArmed
    record.events = state.events.map(makeEventRecord)
    return record
  }

  /// Returns Core Motion history for a diagnostic window. It does not persist
  /// events, start live updates, or change regions and notifications.
  func queryActivityHistory(
    from startValue: String,
    to endValue: String
  ) async throws -> ArrivalDiagnosticHistoryQueryRecord {
    guard buildEnabled else {
      throw ArrivalDiagnosticError.disabledBuild
    }
    guard
      let start = parseHistoryTimestamp(startValue),
      let end = parseHistoryTimestamp(endValue)
    else {
      throw ArrivalDiagnosticError.invalidHistoryWindow(
        "History query timestamps must be UTC ISO-8601, such as 2026-10-16T20:41:23.120Z."
      )
    }

    let duration = end.timeIntervalSince(start)
    if duration <= 0 {
      throw ArrivalDiagnosticError.invalidHistoryWindow(
        "History query start must be before its end."
      )
    }
    if duration > ArrivalDiagnosticConstants.historicalQueryMaximumSeconds {
      throw ArrivalDiagnosticError.invalidHistoryWindow(
        "History queries are limited to 30 minutes."
      )
    }

    guard CMMotionActivityManager.isActivityAvailable() else {
      throw ArrivalDiagnosticError.motionUnavailable
    }
    let authorization = CMMotionActivityManager.authorizationStatus()
    guard authorization == .authorized else {
      throw ArrivalDiagnosticError.motionAuthorizationRequired(
        motionAuthorizationName(authorization)
      )
    }

    ensureMotionManager()
    guard let motionManager else {
      throw ArrivalDiagnosticError.motionUnavailable
    }

    let queried = await fetchHistoricalActivities(
      using: motionManager,
      from: start,
      to: end
    )
    switch queried {
    case .noSamples(let detail):
      return makeHistoryQueryRecord(
        from: start,
        to: end,
        outcome: "no-activity",
        detail: detail,
        activities: []
      )
    case .samples(let activities):
      return makeHistoryQueryRecord(
        from: start,
        to: end,
        outcome: "activities",
        detail: nil,
        activities: activities.sorted { $0.startDate < $1.startDate }
      )
    case .failure(let error):
      throw error
    }
  }

  func makeStatus() async -> ArrivalDiagnosticStatusRecord {
    let pendingRequests =
      await UNUserNotificationCenter.current().pendingNotificationRequests()
    ensureLocationManager()
    let manager = locationManager
    let monitoredRegions = manager?.monitoredRegions ?? []
    let occupied = conservativeOccupiedRegionIdentifiers(
      pendingRequests: pendingRequests
    )
    let record = ArrivalDiagnosticStatusRecord()
    record.buildEnabled = buildEnabled
    record.isArmed = state.isArmed
    record.authorizationStatus = authorizationStatusName(
      manager?.authorizationStatus ?? .notDetermined
    )
    record.accuracyAuthorization = accuracyAuthorizationName(
      manager?.accuracyAuthorization
    )
    record.backgroundRefreshStatus = backgroundRefreshStatusName(
      UIApplication.shared.backgroundRefreshStatus
    )
    record.backgroundModeEnabled = backgroundModeEnabled
    record.regionMonitoringAvailable =
      CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self)
    record.diagnosticRegionRegistered = monitoredDiagnosticRegion(
      in: monitoredRegions
    ).map { isCurrentDiagnosticRadius($0.radius) } ?? false
    record.serviceSessionSupported = {
      if #available(iOS 18.0, *) {
        return true
      }
      return false
    }()
    record.serviceSessionActive = serviceSessionIsActive
    record.liveUpdatesSupported = {
      if #available(iOS 17.0, *) {
        return true
      }
      return false
    }()
    record.observationActive = state.activeObservationIdentifier != nil
    record.observationDeadline = state.observationDeadline
    record.burstActive = record.observationActive
    record.pendingLocationNotificationCount = pendingRequests.filter {
      $0.trigger is UNLocationNotificationTrigger
    }.count
    record.monitoredRegionCount = monitoredRegions.count
    record.conservativeOccupiedRegionCount = occupied.count
    record.motionAvailable = CMMotionActivityManager.isActivityAvailable()
    record.motionAuthorizationStatus = motionAuthorizationStatusName()
    return record
  }

  func locationManager(
    _ manager: CLLocationManager,
    didStartMonitoringFor region: CLRegion
  ) {
    guard isDiagnosticRegion(region) else {
      return
    }
    guard
      !terminateIfDeadlineExpired(reason: "deadline-detected-on-lifecycle")
    else {
      recordRadiusMismatchIfNeeded(
        monitoredRadius: monitoredDiagnosticRegion(
          in: manager.monitoredRegions
        )?.radius,
        source: "region-monitoring-started"
      )
      return
    }
    recordCallbackOccurrence(source: "region-monitoring-started")
    let monitoredRadius = monitoredDiagnosticRegion(
      in: manager.monitoredRegions
    )?.radius
    appendEvent(
      type: "region-monitoring-started",
      detail: regionRadiusDetail(
        requestedRadius: (region as? CLCircularRegion)?.radius
          ?? ArrivalDiagnosticConstants.radiusMeters,
        monitoredRadius: monitoredRadius
      )
    )
    recordRadiusMismatchIfNeeded(
      monitoredRadius: monitoredRadius,
      source: "region-monitoring-started"
    )
  }

  func locationManager(
    _ manager: CLLocationManager,
    monitoringDidFailFor region: CLRegion?,
    withError error: Error
  ) {
    guard region == nil || region.map(isDiagnosticRegion) == true else {
      return
    }
    _ = terminateIfDeadlineExpired(reason: "deadline-detected-on-lifecycle")
    recordCallbackOccurrence(source: "region-monitoring-failed")
    terminateObservation(reason: "region-monitoring-failed")
    state.isArmed = false
    appendEvent(
      type: "diagnostic-disabled",
      detail: "region-monitoring-failed"
    )
    invalidateServiceSession()
    appendEvent(
      type: "region-monitoring-failed",
      detail: sanitizedError(error)
    )
  }

  func locationManager(
    _ manager: CLLocationManager,
    didEnterRegion region: CLRegion
  ) {
    guard state.isArmed, isDiagnosticRegion(region) else {
      return
    }
    guard
      !terminateIfDeadlineExpired(reason: "deadline-detected-on-lifecycle")
    else {
      return
    }
    recordCallbackOccurrence(source: "region-enter")
    appendEvent(type: "region-enter-callback", detail: nil)
    startObservation()
  }

  func locationManager(
    _ manager: CLLocationManager,
    didExitRegion region: CLRegion
  ) {
    guard state.isArmed, isDiagnosticRegion(region) else {
      return
    }
    guard
      !terminateIfDeadlineExpired(reason: "deadline-detected-on-lifecycle")
    else {
      return
    }
    recordCallbackOccurrence(source: "region-exit")
    appendEvent(type: "region-exit-callback", detail: nil)
  }

  func locationManager(
    _ manager: CLLocationManager,
    didFailWithError error: Error
  ) {
    guard state.activeObservationIdentifier != nil else {
      return
    }
    guard
      !terminateIfDeadlineExpired(reason: "deadline-detected-on-live-update")
    else {
      return
    }
    recordCallbackOccurrence(source: "location-manager-error")
    appendEvent(
      type: "region-location-manager-error",
      detail: sanitizedError(error),
      executionDurationSeconds: activeObservationDuration(at: Date())
    )
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard buildEnabled, state.isArmed else {
      return
    }
    _ = terminateIfDeadlineExpired(reason: "deadline-detected-on-lifecycle")
    recordCallbackOccurrence(source: "authorization-change")
    appendEvent(
      type: "authorization-changed",
      detail:
        "\(authorizationStatusName(manager.authorizationStatus))-\(accuracyAuthorizationName(manager.accuracyAuthorization))"
    )
    guard
      manager.authorizationStatus == .authorizedAlways,
      manager.accuracyAuthorization == .fullAccuracy
    else {
      terminateObservation(reason: "authorization-invalid")
      stopDiagnosticRegions()
      state.isArmed = false
      invalidateServiceSession()
      appendEvent(
        type: "diagnostic-ineligible",
        detail: "authorization-invalid"
      )
      return
    }
    if #available(iOS 18.0, *), UIApplication.shared.applicationState == .active {
      establishServiceSession(
        origin: "authorization-restored-foreground",
        reconstructed: false
      )
    }
  }

  func handleDidEnterBackground() {
    handleLifecycleEvent("did-enter-background")
  }

  func handleWillEnterForeground() {
    handleLifecycleEvent("will-enter-foreground")
  }

  func handleDidBecomeActive() {
    handleLifecycleEvent("did-become-active")
    guard state.isArmed else {
      return
    }
    ensureLocationManager()
    guard
      locationManager?.authorizationStatus == .authorizedAlways,
      locationManager?.accuracyAuthorization == .fullAccuracy
    else {
      terminateObservation(reason: "authorization-invalid")
      stopDiagnosticRegions()
      state.isArmed = false
      invalidateServiceSession()
      appendEvent(
        type: "diagnostic-ineligible",
        detail: "authorization-invalid-on-did-become-active"
      )
      return
    }
    if #available(iOS 18.0, *) {
      establishServiceSession(
        origin: "did-become-active",
        reconstructed: false
      )
    }
    recordRadiusMismatchIfNeeded(
      monitoredRadius: monitoredDiagnosticRegion(
        in: locationManager?.monitoredRegions ?? []
      )?.radius,
      source: "did-become-active"
    )
  }

  func handleWillTerminate() {
    handleLifecycleEvent("will-terminate")
  }

  private func handleLifecycleEvent(_ name: String) {
    guard
      buildEnabled,
      state.isArmed || state.activeObservationIdentifier != nil
    else {
      return
    }
    let shouldAssociateWithObservation =
      state.activeObservationIdentifier != nil
    _ = terminateIfDeadlineExpired(
      reason: "deadline-detected-on-lifecycle"
    )
    if shouldAssociateWithObservation {
      recordCallbackOccurrence(source: "lifecycle-\(name)")
    }
    appendEvent(type: "observed-lifecycle", detail: name)
  }

  private var buildEnabled: Bool {
    Bundle.main.object(
      forInfoDictionaryKey: "TYGArrivalDiagnosticEnabled"
    ) as? Bool ?? false
  }

  private var backgroundModeEnabled: Bool {
    let modes = Bundle.main.object(
      forInfoDictionaryKey: "UIBackgroundModes"
    ) as? [String] ?? []
    return modes.contains("location")
  }

  private func ensureLocationManager() {
    guard locationManager == nil else {
      return
    }
    let manager = CLLocationManager()
    manager.delegate = self
    manager.activityType = .other
    manager.desiredAccuracy = kCLLocationAccuracyBest
    manager.distanceFilter = 5
    manager.pausesLocationUpdatesAutomatically = false
    locationManager = manager
  }

  private func monitoredDiagnosticRegion(
    in regions: Set<CLRegion>
  ) -> CLCircularRegion? {
    regions.compactMap { $0 as? CLCircularRegion }.first {
      $0.identifier == ArrivalDiagnosticConstants.regionIdentifier
    }
  }

  private func isCurrentDiagnosticRadius(_ radius: Double) -> Bool {
    abs(radius - ArrivalDiagnosticConstants.radiusMeters)
      < ArrivalDiagnosticConstants.radiusToleranceMeters
  }

  private func radiusText(_ radius: Double) -> String {
    if abs(radius.rounded() - radius) < 0.001 {
      return String(format: "%.0f", locale: Locale(identifier: "en_US_POSIX"), radius)
    }
    return String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), radius)
  }

  private func regionRadiusDetail(
    requestedRadius: Double,
    monitoredRadius: Double?
  ) -> String {
    let monitored = monitoredRadius.map(radiusText) ?? "unavailable"
    return "requestedRadius=\(radiusText(requestedRadius));monitoredRadius=\(monitored)"
  }

  /// Records a wrong read-back and leaves the registered region in place.
  private func recordRadiusMismatchIfNeeded(
    monitoredRadius: Double?,
    source: String
  ) {
    guard
      let monitoredRadius,
      !isCurrentDiagnosticRadius(monitoredRadius)
    else {
      return
    }
    let detail =
      "requestedRadius=\(radiusText(ArrivalDiagnosticConstants.radiusMeters));monitoredRadius=\(radiusText(monitoredRadius));source=\(source)"
    if state.events.contains(where: {
      $0.type == "diagnostic-region-radius-mismatch" && $0.detail == detail
    }) {
      return
    }
    appendEvent(type: "diagnostic-region-radius-mismatch", detail: detail)
  }

  private func diagnosticRegion() -> CLCircularRegion {
    let region = CLCircularRegion(
      center: CLLocationCoordinate2D(
        latitude: ArrivalDiagnosticConstants.latitude,
        longitude: ArrivalDiagnosticConstants.longitude
      ),
      radius: ArrivalDiagnosticConstants.radiusMeters,
      identifier: ArrivalDiagnosticConstants.regionIdentifier
    )
    region.notifyOnEntry = true
    region.notifyOnExit = true
    return region
  }

  private var serviceSessionIsActive: Bool {
    if #available(iOS 18.0, *) {
      return (modernRuntime as? ArrivalDiagnosticModernRuntime)?
        .serviceSession != nil
    }
    return false
  }

  @available(iOS 18.0, *)
  private func establishServiceSession(
    origin: String,
    reconstructed: Bool
  ) {
    let runtime: ArrivalDiagnosticModernRuntime
    if let existing = modernRuntime as? ArrivalDiagnosticModernRuntime {
      runtime = existing
    } else {
      runtime = ArrivalDiagnosticModernRuntime()
      modernRuntime = runtime
    }
    guard runtime.serviceSession == nil else {
      return
    }

    let session = CLServiceSession(authorization: .always)
    runtime.serviceSession = session
    appendEvent(type: "service-session-established", detail: origin)
    if reconstructed {
      appendEvent(
        type: "observed-session-reconstruction",
        detail: origin
      )
    }

    runtime.serviceDiagnosticsTask = Task { @MainActor [weak self] in
      do {
        for try await diagnostic in session.diagnostics {
          guard !Task.isCancelled else {
            return
          }
          self?.recordServiceSessionDiagnostic(
            diagnostic,
            session: session
          )
        }
      } catch is CancellationError {
        return
      } catch {
        self?.appendEvent(
          type: "service-session-diagnostic-error",
          detail: self?.sanitizedError(error)
        )
      }
    }
  }

  @available(iOS 18.0, *)
  private func recordServiceSessionDiagnostic(
    _ diagnostic: CLServiceSession.Diagnostic,
    session: CLServiceSession
  ) {
    guard
      let runtime = modernRuntime as? ArrivalDiagnosticModernRuntime,
      runtime.serviceSession === session
    else {
      return
    }
    _ = terminateIfDeadlineExpired(
      reason: "deadline-detected-on-lifecycle"
    )
    let flags = [
      ("authorization-denied", diagnostic.authorizationDenied),
      ("authorization-denied-globally", diagnostic.authorizationDeniedGlobally),
      ("authorization-restricted", diagnostic.authorizationRestricted),
      ("insufficiently-in-use", diagnostic.insufficientlyInUse),
      ("service-session-required", diagnostic.serviceSessionRequired),
      ("full-accuracy-denied", diagnostic.fullAccuracyDenied),
      ("always-authorization-denied", diagnostic.alwaysAuthorizationDenied),
      (
        "authorization-request-in-progress",
        diagnostic.authorizationRequestInProgress
      ),
    ].compactMap { $0.1 ? $0.0 : nil }
    appendEvent(
      type: "service-session-diagnostic",
      detail: flags.isEmpty ? "none" : flags.joined(separator: ",")
    )
    let authorizationInvalid =
      diagnostic.authorizationDenied
      || diagnostic.authorizationDeniedGlobally
      || diagnostic.authorizationRestricted
      || diagnostic.fullAccuracyDenied
      || diagnostic.alwaysAuthorizationDenied
    guard authorizationInvalid else {
      return
    }
    terminateObservation(reason: "authorization-invalid")
    stopDiagnosticRegions()
    state.isArmed = false
    appendEvent(
      type: "diagnostic-ineligible",
      detail: "authorization-invalid-service-session-diagnostic"
    )
    invalidateServiceSession()
  }

  private func invalidateServiceSession() {
    guard #available(iOS 18.0, *) else {
      modernRuntime = nil
      return
    }
    guard let runtime = modernRuntime as? ArrivalDiagnosticModernRuntime else {
      return
    }
    runtime.serviceDiagnosticsTask?.cancel()
    runtime.serviceDiagnosticsTask = nil
    runtime.serviceSession?.invalidate()
    runtime.serviceSession = nil
    runtime.liveUpdatesTask?.cancel()
    runtime.liveUpdatesTask = nil
    modernRuntime = nil
  }

  private func startObservation() {
    guard #available(iOS 18.0, *) else {
      appendEvent(
        type: "live-observation-unavailable",
        detail: "requires-ios-18"
      )
      return
    }
    startModernObservation()
  }

  @available(iOS 18.0, *)
  private func startModernObservation() {
    guard state.activeObservationIdentifier == nil else {
      appendEvent(
        type: "duplicate-region-entry",
        detail: "observation-already-active"
      )
      return
    }

    let startedAt = Date()
    let deadline = startedAt.addingTimeInterval(
      ArrivalDiagnosticConstants.observationDurationSeconds
    )
    let observationIdentifier = UUID().uuidString.lowercased()

    // This state is durable before any asynchronous location or motion work.
    state.activeObservationIdentifier = observationIdentifier
    state.observationStartedAt = timestamp(startedAt)
    state.observationDeadline = timestamp(deadline)
    state.lastLiveUpdateReceivedAt = nil
    state.lastObservedCallbackAt = timestamp(startedAt)
    saveState()
    appendEvent(
      type: "live-observation-started",
      detail:
        "deadline=\(timestamp(deadline));durationSeconds=\(ArrivalDiagnosticConstants.observationDurationSeconds)",
      observationIdentifier: observationIdentifier
    )

    beginSetupBackgroundTask(for: observationIdentifier)
    startLiveUpdates(for: observationIdentifier, reconstructed: false)
    startMotionCapture(for: observationIdentifier)
    startDeadlineTimer(
      for: observationIdentifier,
      deadline: deadline
    )
  }

  @available(iOS 18.0, *)
  private func startLiveUpdates(
    for observationIdentifier: String,
    reconstructed: Bool
  ) {
    establishServiceSession(
      origin: reconstructed
        ? "live-observation-reconstruction"
        : "active-observation",
      reconstructed: reconstructed
    )
    guard let runtime = modernRuntime as? ArrivalDiagnosticModernRuntime else {
      terminateObservation(reason: "live-update-stream-error")
      return
    }

    runtime.liveUpdatesTask?.cancel()
    runtime.liveUpdatesTask = Task { @MainActor [weak self] in
      do {
        for try await update in CLLocationUpdate.liveUpdates() {
          guard !Task.isCancelled else {
            return
          }
          self?.handleLiveUpdate(
            update,
            observationIdentifier: observationIdentifier
          )
        }
        self?.handleLiveUpdateStreamEnd(
          observationIdentifier: observationIdentifier,
          error: nil
        )
      } catch is CancellationError {
        return
      } catch {
        self?.handleLiveUpdateStreamEnd(
          observationIdentifier: observationIdentifier,
          error: error
        )
      }
    }
  }

  @available(iOS 18.0, *)
  private func handleLiveUpdate(
    _ update: CLLocationUpdate,
    observationIdentifier: String
  ) {
    guard state.activeObservationIdentifier == observationIdentifier else {
      return
    }
    guard
      !terminateIfDeadlineExpired(
        reason: "deadline-detected-on-live-update"
      )
    else {
      return
    }

    let now = Date()
    recordCallbackOccurrence(source: "live-location-update", at: now)
    state.lastLiveUpdateReceivedAt = timestamp(now)
    let flags = liveUpdateFlags(update)

    guard let location = update.location else {
      appendEvent(
        type: "live-location-update",
        detail: "nil-location;flags=\(flags)",
        executionDurationSeconds: activeObservationDuration(at: now),
        observationIdentifier: observationIdentifier
      )
      return
    }

    let ageSeconds = now.timeIntervalSince(location.timestamp)
    let storeLocation = CLLocation(
      latitude: ArrivalDiagnosticConstants.latitude,
      longitude: ArrivalDiagnosticConstants.longitude
    )
    appendEvent(
      type: "live-location-update",
      detail: "flags=\(flags)",
      locationTimestamp: timestamp(location.timestamp),
      horizontalAccuracyMeters: validMeasurement(location.horizontalAccuracy),
      speedMetersPerSecond: validMeasurement(location.speed),
      speedAccuracyMetersPerSecond: validMeasurement(location.speedAccuracy),
      distanceFromStoreMeters: location.distance(from: storeLocation),
      sampleAgeSeconds: ageSeconds,
      isFreshLocation:
        abs(ageSeconds) <=
        ArrivalDiagnosticConstants.freshLocationMaximumAgeSeconds,
      executionDurationSeconds: activeObservationDuration(at: now),
      observationIdentifier: observationIdentifier
    )
    maybeRecordDriveAwayWouldEnd()
  }

  @available(iOS 18.0, *)
  private func liveUpdateFlags(_ update: CLLocationUpdate) -> String {
    let flags = [
      ("stationary", update.stationary),
      ("authorization-denied", update.authorizationDenied),
      ("authorization-denied-globally", update.authorizationDeniedGlobally),
      ("authorization-restricted", update.authorizationRestricted),
      ("insufficiently-in-use", update.insufficientlyInUse),
      ("location-unavailable", update.locationUnavailable),
      ("accuracy-limited", update.accuracyLimited),
      ("service-session-required", update.serviceSessionRequired),
      (
        "authorization-request-in-progress",
        update.authorizationRequestInProgress
      ),
    ].compactMap { $0.1 ? $0.0 : nil }
    return flags.isEmpty ? "none" : flags.joined(separator: ",")
  }

  private func handleLiveUpdateStreamEnd(
    observationIdentifier: String,
    error: Error?
  ) {
    guard state.activeObservationIdentifier == observationIdentifier else {
      return
    }
    if let error {
      appendEvent(
        type: "live-update-stream-error",
        detail: sanitizedError(error),
        observationIdentifier: observationIdentifier
      )
      terminateObservation(reason: "live-update-stream-error")
    } else {
      terminateObservation(reason: "live-update-stream-ended")
    }
  }

  private func reconstructObservationIfNeeded() {
    guard let observationIdentifier = state.activeObservationIdentifier else {
      return
    }
    guard
      let deadlineValue = state.observationDeadline,
      let deadline = parseTimestamp(deadlineValue)
    else {
      terminateObservation(reason: "deadline-detected-on-launch")
      return
    }
    guard
      !terminateIfDeadlineExpired(reason: "deadline-detected-on-launch")
    else {
      return
    }
    guard #available(iOS 18.0, *) else {
      terminateObservation(reason: "authorization-invalid")
      return
    }

    appendEvent(
      type: "live-observation-reconstructed",
      detail: "deadline=\(deadlineValue)",
      executionDurationSeconds: activeObservationDuration(at: Date()),
      observationIdentifier: observationIdentifier
    )
    beginSetupBackgroundTask(for: observationIdentifier)
    startLiveUpdates(for: observationIdentifier, reconstructed: true)
    startMotionCapture(for: observationIdentifier)
    // Keep the deadline stored at observation start. Changing the duration
    // constant does not extend an observation that is already in progress.
    startDeadlineTimer(
      for: observationIdentifier,
      deadline: deadline
    )
    maybeRecordDriveAwayWouldEnd()
  }

  private func startDeadlineTimer(
    for observationIdentifier: String,
    deadline: Date
  ) {
    observationDeadlineTask?.cancel()
    observationDeadlineTask = Task { @MainActor [weak self] in
      let remaining = max(0, deadline.timeIntervalSinceNow)
      let nanoseconds = UInt64(remaining * 1_000_000_000)
      try? await Task.sleep(nanoseconds: nanoseconds)
      guard !Task.isCancelled else {
        return
      }
      guard
        self?.state.activeObservationIdentifier == observationIdentifier
      else {
        return
      }
      self?.terminateObservation(reason: "deadline-timer-fired")
    }
  }

  private func terminateIfDeadlineExpired(reason: String) -> Bool {
    guard state.activeObservationIdentifier != nil else {
      return false
    }
    guard
      let deadlineValue = state.observationDeadline,
      let deadline = parseTimestamp(deadlineValue),
      Date() < deadline
    else {
      terminateObservation(reason: reason)
      return true
    }
    return false
  }

  private func terminateObservation(reason: String) {
    guard let observationIdentifier = state.activeObservationIdentifier else {
      endSetupBackgroundTask()
      return
    }
    let duration = activeObservationDuration(at: Date())

    if #available(iOS 18.0, *),
      let runtime = modernRuntime as? ArrivalDiagnosticModernRuntime
    {
      runtime.liveUpdatesTask?.cancel()
      runtime.liveUpdatesTask = nil
    }
    observationDeadlineTask?.cancel()
    observationDeadlineTask = nil
    stopMotionUpdates(logEvent: true)
    recordedActivityKeys.removeAll()
    endSetupBackgroundTask()

    state.activeObservationIdentifier = nil
    state.observationStartedAt = nil
    state.observationDeadline = nil
    state.lastLiveUpdateReceivedAt = nil
    state.lastObservedCallbackAt = nil
    saveState()
    appendEvent(
      type: "observation-ended",
      detail: reason,
      executionDurationSeconds: duration,
      observationIdentifier: observationIdentifier
    )
  }

  private func beginSetupBackgroundTask(for observationIdentifier: String) {
    endSetupBackgroundTask()
    backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(
      withName: "ThereYouGoArrivalDiagnosticSetup"
    ) { [weak self] in
      Task { @MainActor in
        self?.handleSetupBackgroundTaskExpiration(
          observationIdentifier: observationIdentifier
        )
      }
    }
    appendEvent(
      type: "uikit-background-task-started",
      detail: "setup-and-initial-persistence-only",
      observationIdentifier: observationIdentifier
    )
  }

  private func handleSetupBackgroundTaskExpiration(
    observationIdentifier: String
  ) {
    guard backgroundTaskIdentifier != .invalid else {
      return
    }
    if state.activeObservationIdentifier == observationIdentifier {
      appendEvent(
        type: "uikit-background-task-expired",
        detail: "observation-continues-until-deadline-or-stream-end",
        executionDurationSeconds: activeObservationDuration(at: Date()),
        observationIdentifier: observationIdentifier
      )
    }
    endSetupBackgroundTask()
  }

  private func endSetupBackgroundTask() {
    guard backgroundTaskIdentifier != .invalid else {
      return
    }
    let identifier = backgroundTaskIdentifier
    backgroundTaskIdentifier = .invalid
    UIApplication.shared.endBackgroundTask(identifier)
  }

  private func activeObservationDuration(at date: Date) -> Double? {
    guard
      let value = state.observationStartedAt,
      let startedAt = parseTimestamp(value)
    else {
      return nil
    }
    return max(0, date.timeIntervalSince(startedAt))
  }

  private func recordCallbackOccurrence(
    source: String,
    at date: Date = Date()
  ) {
    guard state.activeObservationIdentifier != nil else {
      return
    }
    let previous = state.lastObservedCallbackAt.flatMap(parseTimestamp)
    state.lastObservedCallbackAt = timestamp(date)
    saveState()
    guard let previous else {
      return
    }
    let gap = max(0, date.timeIntervalSince(previous))
    guard
      gap >= ArrivalDiagnosticConstants.inferredCallbackGapMinimumSeconds
    else {
      return
    }
    appendEvent(
      type: "inferred-callback-gap",
      detail: String(
        format: "source=%@;durationSeconds=%.3f",
        source,
        gap
      ),
      executionDurationSeconds: activeObservationDuration(at: date)
    )
  }

  private func stopDiagnosticRegions() {
    stopStaleDiagnosticRegions()
    guard let locationManager else {
      return
    }
    for region in locationManager.monitoredRegions where isDiagnosticRegion(region) {
      locationManager.stopMonitoring(for: region)
    }
  }

  /// Removes a prior diagnostic target, such as Shell Food Mart, while leaving
  /// the current region and every persisted event untouched.
  private func stopStaleDiagnosticRegions() {
    guard let locationManager else {
      return
    }
    for region in locationManager.monitoredRegions
      where isDiagnosticRegion(region)
        && region.identifier != ArrivalDiagnosticConstants.regionIdentifier
    {
      locationManager.stopMonitoring(for: region)
      appendEvent(
        type: "diagnostic-region-retired",
        detail: region.identifier
      )
    }
  }

  private func conservativeOccupiedRegionIdentifiers(
    pendingRequests: [UNNotificationRequest]
  ) -> Set<String> {
    let notificationRegionIdentifiers = pendingRequests.compactMap { request in
      request.trigger is UNLocationNotificationTrigger
        ? request.identifier
        : nil
    }
    let monitoredRegionIdentifiers =
      locationManager?.monitoredRegions.map(\.identifier) ?? []
    return Set(notificationRegionIdentifiers + monitoredRegionIdentifiers)
  }

  private func isDiagnosticRegion(_ region: CLRegion) -> Bool {
    isDiagnosticRegionIdentifier(region.identifier)
  }

  private func isDiagnosticRegionIdentifier(_ identifier: String) -> Bool {
    identifier.hasPrefix(ArrivalDiagnosticConstants.regionIdentifierPrefix)
  }

  private func appendEvent(
    type: String,
    detail: String?,
    recordedAt: Date = Date(),
    locationTimestamp: String? = nil,
    horizontalAccuracyMeters: Double? = nil,
    speedMetersPerSecond: Double? = nil,
    speedAccuracyMetersPerSecond: Double? = nil,
    distanceFromStoreMeters: Double? = nil,
    sampleAgeSeconds: Double? = nil,
    isFreshLocation: Bool? = nil,
    executionDurationSeconds: Double? = nil,
    activityStartTimestamp: String? = nil,
    activityAutomotive: Bool? = nil,
    activityStationary: Bool? = nil,
    activityWalking: Bool? = nil,
    activityRunning: Bool? = nil,
    activityUnknown: Bool? = nil,
    activityCycling: Bool? = nil,
    activityConfidence: String? = nil,
    observationIdentifier: String? = nil
  ) {
    let nextSequence = (state.events.last?.sequence ?? 0) + 1
    state.events.append(
      PersistedArrivalDiagnosticEvent(
        sequence: nextSequence,
        type: type,
        recordedAt: timestamp(recordedAt),
        appState: applicationStateName(UIApplication.shared.applicationState),
        detail: detail,
        locationTimestamp: locationTimestamp,
        horizontalAccuracyMeters: horizontalAccuracyMeters,
        speedMetersPerSecond: speedMetersPerSecond,
        speedAccuracyMetersPerSecond: speedAccuracyMetersPerSecond,
        distanceFromStoreMeters: distanceFromStoreMeters,
        sampleAgeSeconds: sampleAgeSeconds,
        isFreshLocation: isFreshLocation,
        executionDurationSeconds: executionDurationSeconds,
        activityStartTimestamp: activityStartTimestamp,
        activityAutomotive: activityAutomotive,
        activityStationary: activityStationary,
        activityWalking: activityWalking,
        activityRunning: activityRunning,
        activityUnknown: activityUnknown,
        activityCycling: activityCycling,
        activityConfidence: activityConfidence,
        observationIdentifier:
          observationIdentifier ?? state.activeObservationIdentifier
      )
    )
    if state.events.count > ArrivalDiagnosticConstants.maximumEvents {
      state.events.removeFirst(
        state.events.count - ArrivalDiagnosticConstants.maximumEvents
      )
    }
    saveState()
  }

  private func saveState() {
    guard !persistenceBlocked else {
      return
    }
    guard let data = try? encoder.encode(state) else {
      return
    }
    UserDefaults.standard.set(
      data,
      forKey: ArrivalDiagnosticConstants.userDefaultsKey
    )
  }

  private static func loadState(
    decoder: JSONDecoder
  ) -> LoadedArrivalDiagnosticState {
    guard
      let data = UserDefaults.standard.data(
        forKey: ArrivalDiagnosticConstants.userDefaultsKey
      )
    else {
      return LoadedArrivalDiagnosticState(
        state: .empty,
        migratedFromV2: false,
        persistenceBlocked: false
      )
    }

    struct SchemaEnvelope: Decodable {
      let schemaVersion: Int
    }

    guard
      let envelope = try? decoder.decode(SchemaEnvelope.self, from: data)
    else {
      return LoadedArrivalDiagnosticState(
        state: .empty,
        migratedFromV2: false,
        persistenceBlocked: true
      )
    }

    if envelope.schemaVersion == ArrivalDiagnosticConstants.schemaVersion,
      let state = try? decoder.decode(
        PersistedArrivalDiagnosticState.self,
        from: data
      )
    {
      return LoadedArrivalDiagnosticState(
        state: state,
        migratedFromV2: false,
        persistenceBlocked: false
      )
    }

    if envelope.schemaVersion == ArrivalDiagnosticConstants.previousSchemaVersion,
      let previous = try? decoder.decode(
        PersistedArrivalDiagnosticStateV2.self,
        from: data
      )
    {
      let startedAt = previous.activeBurstStartedAt
      let deadline = startedAt
        .flatMap(parsePersistedTimestamp)
        .map {
          persistedTimestamp(
            $0.addingTimeInterval(
              ArrivalDiagnosticConstants.migratedBurstDurationSeconds
            )
          )
        }
      let identifier = startedAt.map {
        "migrated-v2-\($0)"
      }
      return LoadedArrivalDiagnosticState(
        state: PersistedArrivalDiagnosticState(
          schemaVersion: ArrivalDiagnosticConstants.schemaVersion,
          isArmed: previous.isArmed,
          activeObservationIdentifier: identifier,
          observationStartedAt: startedAt,
          observationDeadline: deadline,
          lastLiveUpdateReceivedAt: nil,
          lastObservedCallbackAt: startedAt,
          events: previous.events
        ),
        migratedFromV2: true,
        persistenceBlocked: false
      )
    }

    return LoadedArrivalDiagnosticState(
      state: .empty,
      migratedFromV2: false,
      persistenceBlocked: true
    )
  }

  private func timestamp(_ date: Date) -> String {
    Self.persistedTimestamp(date)
  }

  private static func persistedTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private func parseTimestamp(_ value: String) -> Date? {
    Self.parsePersistedTimestamp(value)
  }

  private static func parsePersistedTimestamp(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.date(from: value)
  }

  private func parseHistoryTimestamp(_ value: String) -> Date? {
    let pattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"#
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      return nil
    }

    if let fractional = iso8601Date(from: value, fractionalSeconds: true) {
      return fractional
    }
    return iso8601Date(from: value, fractionalSeconds: false)
  }

  private func iso8601Date(
    from value: String,
    fractionalSeconds: Bool
  ) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.formatOptions = fractionalSeconds
      ? [.withInternetDateTime, .withFractionalSeconds]
      : [.withInternetDateTime]
    return formatter.date(from: value)
  }

  private func validMeasurement(_ value: Double) -> Double? {
    value >= 0 && value.isFinite ? value : nil
  }

  private func sanitizedError(_ error: Error) -> String {
    let error = error as NSError
    return "\(error.domain):\(error.code)"
  }

  private func authorizationStatusName(
    _ status: CLAuthorizationStatus
  ) -> String {
    switch status {
    case .notDetermined:
      return "not-determined"
    case .restricted:
      return "restricted"
    case .denied:
      return "denied"
    case .authorizedAlways:
      return "always"
    case .authorizedWhenInUse:
      return "when-in-use"
    @unknown default:
      return "unknown"
    }
  }

  private func accuracyAuthorizationName(
    _ authorization: CLAccuracyAuthorization?
  ) -> String {
    switch authorization {
    case .fullAccuracy:
      return "full"
    case .reducedAccuracy:
      return "reduced"
    case nil:
      return "unknown"
    @unknown default:
      return "unknown"
    }
  }

  private func backgroundRefreshStatusName(
    _ status: UIBackgroundRefreshStatus
  ) -> String {
    switch status {
    case .available:
      return "available"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    @unknown default:
      return "unknown"
    }
  }

  private func applicationStateName(_ state: UIApplication.State) -> String {
    switch state {
    case .active:
      return "active"
    case .inactive:
      return "inactive"
    case .background:
      return "background"
    @unknown default:
      return "unknown"
    }
  }

  private func makeEventRecord(
    _ event: PersistedArrivalDiagnosticEvent
  ) -> ArrivalDiagnosticEventRecord {
    let record = ArrivalDiagnosticEventRecord()
    record.sequence = event.sequence
    record.type = event.type
    record.recordedAt = event.recordedAt
    record.appState = event.appState
    record.detail = event.detail
    record.locationTimestamp = event.locationTimestamp
    record.horizontalAccuracyMeters = event.horizontalAccuracyMeters
    record.speedMetersPerSecond = event.speedMetersPerSecond
    record.speedAccuracyMetersPerSecond = event.speedAccuracyMetersPerSecond
    record.distanceFromStoreMeters = event.distanceFromStoreMeters
    record.sampleAgeSeconds = event.sampleAgeSeconds
    record.isFreshLocation = event.isFreshLocation
    record.executionDurationSeconds = event.executionDurationSeconds
    record.activityStartTimestamp = event.activityStartTimestamp
    record.activityAutomotive = event.activityAutomotive
    record.activityStationary = event.activityStationary
    record.activityWalking = event.activityWalking
    record.activityRunning = event.activityRunning
    record.activityUnknown = event.activityUnknown
    record.activityCycling = event.activityCycling
    record.activityConfidence = event.activityConfidence
    record.observationIdentifier = event.observationIdentifier
    return record
  }

  private func prepareMotionAccess() async {
    guard CMMotionActivityManager.isActivityAvailable() else {
      appendEvent(type: "motion-unavailable", detail: "activity-not-available")
      return
    }

    switch CMMotionActivityManager.authorizationStatus() {
    case .denied, .restricted:
      appendEvent(
        type: "motion-authorization-denied",
        detail: motionAuthorizationName(
          CMMotionActivityManager.authorizationStatus()
        )
      )
    case .authorized:
      appendEvent(type: "motion-authorization-ready", detail: "authorized")
    case .notDetermined:
      appendEvent(type: "motion-permission-requested", detail: "not-determined")
      await queryActivities(
        from: Date().addingTimeInterval(-1),
        to: Date(),
        source: "authorization-prompt"
      )
      let status = CMMotionActivityManager.authorizationStatus()
      appendEvent(
        type: status == .authorized
          ? "motion-authorization-ready"
          : "motion-authorization-denied",
        detail: motionAuthorizationName(status)
      )
    @unknown default:
      appendEvent(type: "motion-authorization-unknown", detail: "unknown")
    }
  }

  private func startMotionCapture(for observationIdentifier: String) {
    recordedActivityKeys.removeAll()
    guard CMMotionActivityManager.isActivityAvailable() else {
      appendEvent(type: "motion-unavailable", detail: "activity-not-available")
      return
    }
    guard CMMotionActivityManager.authorizationStatus() == .authorized else {
      appendEvent(
        type: "motion-updates-skipped",
        detail: motionAuthorizationName(
          CMMotionActivityManager.authorizationStatus()
        )
      )
      return
    }

    ensureMotionManager()
    motionManager?.startActivityUpdates(to: motionCallbackQueue) {
      [weak self] activity in
      guard let activity else {
        return
      }
      Task { @MainActor in
        self?.handleMotionActivity(
          activity,
          observationIdentifier: observationIdentifier
        )
      }
    }
    motionUpdatesActive = true
    appendEvent(type: "motion-updates-started", detail: nil)

    let now = Date()
    Task { @MainActor [weak self] in
      await self?.queryActivities(
        from: now.addingTimeInterval(
          -ArrivalDiagnosticConstants.historicalLookbackSeconds
        ),
        to: now,
        source: "historical-query",
        observationIdentifier: observationIdentifier
      )
    }
  }

  private func handleMotionActivity(
    _ activity: CMMotionActivity,
    observationIdentifier: String
  ) {
    guard state.activeObservationIdentifier == observationIdentifier else {
      return
    }
    guard
      !terminateIfDeadlineExpired(
        reason: "deadline-detected-on-motion-callback"
      )
    else {
      return
    }
    recordCallbackOccurrence(source: "motion-activity")
    recordActivity(
      activity,
      source: "live",
      observationIdentifier: observationIdentifier
    )
  }

  private func stopMotionUpdates(logEvent: Bool) {
    guard motionUpdatesActive else {
      motionManager?.stopActivityUpdates()
      return
    }
    motionManager?.stopActivityUpdates()
    motionUpdatesActive = false
    if logEvent {
      appendEvent(type: "motion-updates-stopped", detail: nil)
    }
  }

  private func ensureMotionManager() {
    guard motionManager == nil else {
      return
    }
    motionManager = CMMotionActivityManager()
  }

  private func fetchHistoricalActivities(
    using motionManager: CMMotionActivityManager,
    from start: Date,
    to end: Date
  ) async -> HistoricalActivityFetch {
    let result: Result<[CMMotionActivity], Error> = await withCheckedContinuation { continuation in
      motionManager.queryActivityStarting(
        from: start,
        to: end,
        to: motionCallbackQueue
      ) { activities, error in
        if let error {
          continuation.resume(returning: .failure(error))
          return
        }
        continuation.resume(returning: .success(activities ?? []))
      }
    }

    switch result {
    case .success(let activities):
      guard !activities.isEmpty else {
        return .noSamples("empty")
      }
      return .samples(activities)
    case .failure(let error):
      return classifyHistoricalQueryError(error)
    }
  }

  private func classifyHistoricalQueryError(
    _ error: Error
  ) -> HistoricalActivityFetch {
    let nsError = error as NSError
    if isCoreMotionError(nsError, CoreMotionHistoryErrorCode.unknown) {
      return .noSamples("cm-error-unknown")
    }
    if isCoreMotionError(nsError, CoreMotionHistoryErrorCode.motionActivityNotAuthorized)
      || isCoreMotionError(nsError, CoreMotionHistoryErrorCode.notAuthorized)
    {
      return .failure(
        .motionAuthorizationRequired(motionAuthorizationStatusName())
      )
    }
    if isCoreMotionError(nsError, CoreMotionHistoryErrorCode.motionActivityNotAvailable)
      || isCoreMotionError(nsError, CoreMotionHistoryErrorCode.notAvailable)
    {
      return .failure(.motionUnavailable)
    }
    return .failure(.motionQueryFailed(sanitizedError(error)))
  }

  private func isCoreMotionError(_ error: NSError, _ code: Int) -> Bool {
    error.domain == CMErrorDomain && error.code == code
  }

  private func makeHistoryQueryRecord(
    from start: Date,
    to end: Date,
    outcome: String,
    detail: String?,
    activities: [CMMotionActivity]
  ) -> ArrivalDiagnosticHistoryQueryRecord {
    let record = ArrivalDiagnosticHistoryQueryRecord()
    record.outcome = outcome
    record.from = timestamp(start)
    record.to = timestamp(end)
    record.detail = detail
    record.activities = activities.map(makeActivitySample)
    return record
  }

  private func makeActivitySample(
    _ activity: CMMotionActivity
  ) -> ArrivalDiagnosticActivitySampleRecord {
    let sample = ArrivalDiagnosticActivitySampleRecord()
    sample.activityStartTimestamp = timestamp(activity.startDate)
    sample.automotive = activity.automotive
    sample.stationary = activity.stationary
    sample.walking = activity.walking
    sample.running = activity.running
    sample.cycling = activity.cycling
    sample.unknown = activity.unknown
    sample.confidence = activityConfidenceName(activity.confidence)
    return sample
  }

  private func queryActivities(
    from start: Date,
    to end: Date,
    source: String,
    observationIdentifier: String? = nil
  ) async {
    guard CMMotionActivityManager.isActivityAvailable() else {
      return
    }
    let authorization = CMMotionActivityManager.authorizationStatus()
    guard authorization == .authorized || authorization == .notDetermined else {
      return
    }

    ensureMotionManager()
    guard let motionManager else {
      return
    }

    let result: Result<[CMMotionActivity], Error> = await withCheckedContinuation { continuation in
      motionManager.queryActivityStarting(
        from: start,
        to: end,
        to: motionCallbackQueue
      ) { activities, error in
        if let error {
          continuation.resume(returning: .failure(error))
          return
        }
        continuation.resume(returning: .success(activities ?? []))
      }
    }

    if let observationIdentifier {
      guard
        state.activeObservationIdentifier == observationIdentifier
      else {
        return
      }
      guard
        !terminateIfDeadlineExpired(
          reason: "deadline-detected-on-motion-callback"
        )
      else {
        return
      }
      recordCallbackOccurrence(source: "motion-history-query")
    }

    switch result {
    case .failure(let error):
      appendEvent(type: "activity-query-failed", detail: sanitizedError(error))
    case .success(let activities):
      guard !activities.isEmpty else {
        appendEvent(type: "activity-query-empty", detail: source)
        return
      }
      let recent = Array(
        activities.suffix(ArrivalDiagnosticConstants.maximumHistoricalActivities)
      )
      for activity in recent {
        recordActivity(
          activity,
          source: source,
          observationIdentifier: observationIdentifier
        )
      }
    }
  }

  private func recordActivity(
    _ activity: CMMotionActivity,
    source: String,
    observationIdentifier: String? = nil
  ) {
    if let observationIdentifier {
      guard state.activeObservationIdentifier == observationIdentifier else {
        return
      }
    }
    let key = activityKey(activity)
    if !recordedActivityKeys.insert(key).inserted {
      return
    }

    let labels = [
      ("automotive", activity.automotive),
      ("stationary", activity.stationary),
      ("walking", activity.walking),
      ("running", activity.running),
      ("unknown", activity.unknown),
    ].compactMap { $0.1 ? $0.0 : nil }
    let cyclingSuffix = activity.cycling ? "+cycling" : ""
    let detail =
      "\(source):\(labels.isEmpty ? "none" : labels.joined(separator: ","))\(cyclingSuffix):\(activityConfidenceName(activity.confidence))"

    appendEvent(
      type: "activity-classification",
      detail: detail,
      executionDurationSeconds: activeObservationDuration(at: Date()),
      activityStartTimestamp: timestamp(activity.startDate),
      activityAutomotive: activity.automotive,
      activityStationary: activity.stationary,
      activityWalking: activity.walking,
      activityRunning: activity.running,
      activityUnknown: activity.unknown,
      activityCycling: activity.cycling,
      activityConfidence: activityConfidenceName(activity.confidence),
      observationIdentifier: observationIdentifier
    )
    maybeRecordSmartArrivalWouldNotify(
      activity: activity,
      source: source,
      observationIdentifier: observationIdentifier
    )
    maybeRecordDriveAwayWouldEnd()
  }

  private func maybeRecordSmartArrivalWouldNotify(
    activity: CMMotionActivity,
    source: String,
    observationIdentifier: String?
  ) {
    guard
      let observationIdentifier,
      state.activeObservationIdentifier == observationIdentifier,
      source == "live" || source == "historical-query",
      activity.walking,
      !activity.automotive,
      activity.confidence == .high,
      let observationStartedValue = state.observationStartedAt,
      let observationStartedAt = parseTimestamp(observationStartedValue),
      activity.startDate >= observationStartedAt,
      !hasSmartArrivalDecision(for: observationIdentifier)
    else {
      return
    }

    let decisionAt = Date()
    let walkingStartedAt = timestamp(activity.startDate)
    let elapsed = max(0, decisionAt.timeIntervalSince(observationStartedAt))
    let freshLocation = latestFreshLocationEvent(
      observationIdentifier: observationIdentifier
    )
    appendEvent(
      type: "smart-arrival-would-notify",
      detail: smartArrivalWouldNotifyDetail(
        walkingStartedAt: walkingStartedAt,
        decisionAt: timestamp(decisionAt),
        elapsedSeconds: elapsed,
        priorAutomotive: priorAutomotiveEvidence(
          observationIdentifier: observationIdentifier,
          before: activity.startDate
        ),
        freshLocation: freshLocation,
        remainingDeadlineSeconds: remainingDeadlineSeconds(at: decisionAt),
        backgroundTaskActive: backgroundTaskIdentifier != .invalid,
        observationReconstructed: observationWasReconstructed(
          observationIdentifier
        )
      ),
      recordedAt: decisionAt,
      locationTimestamp: freshLocation?.locationTimestamp,
      horizontalAccuracyMeters: freshLocation?.horizontalAccuracyMeters,
      speedMetersPerSecond: freshLocation?.speedMetersPerSecond,
      speedAccuracyMetersPerSecond: freshLocation?.speedAccuracyMetersPerSecond,
      distanceFromStoreMeters: freshLocation?.distanceFromStoreMeters,
      sampleAgeSeconds: freshLocation?.sampleAgeSeconds,
      isFreshLocation: freshLocation == nil ? nil : true,
      executionDurationSeconds: elapsed,
      activityStartTimestamp: walkingStartedAt,
      activityAutomotive: activity.automotive,
      activityStationary: activity.stationary,
      activityWalking: activity.walking,
      activityRunning: activity.running,
      activityUnknown: activity.unknown,
      activityCycling: activity.cycling,
      activityConfidence: activityConfidenceName(activity.confidence),
      observationIdentifier: observationIdentifier
    )
  }

  private func hasSmartArrivalDecision(for observationIdentifier: String) -> Bool {
    state.events.contains {
      $0.type == "smart-arrival-would-notify"
        && $0.observationIdentifier == observationIdentifier
    }
  }

  private struct PriorAutomotiveEvidence {
    let activityStartedAt: String
    let confidence: String
    let source: String
  }

  private func priorAutomotiveEvidence(
    observationIdentifier: String,
    before walkingStart: Date
  ) -> PriorAutomotiveEvidence? {
    var selected: (start: Date, evidence: PriorAutomotiveEvidence)?
    for event in state.events {
      guard
        event.observationIdentifier == observationIdentifier,
        event.type == "activity-classification",
        event.activityAutomotive == true,
        let startValue = event.activityStartTimestamp,
        let start = parseTimestamp(startValue),
        start < walkingStart,
        let confidence = event.activityConfidence,
        let source = activityDetailSource(event.detail)
      else {
        continue
      }
      if let selected, start <= selected.start {
        continue
      }
      selected = (
        start,
        PriorAutomotiveEvidence(
          activityStartedAt: startValue,
          confidence: confidence,
          source: source
        )
      )
    }
    return selected?.evidence
  }

  private func activityDetailSource(_ detail: String?) -> String? {
    guard
      let detail,
      let separator = detail.firstIndex(of: ":")
    else {
      return nil
    }
    switch String(detail[..<separator]) {
    case "live", "historical-query", "authorization-prompt":
      return String(detail[..<separator])
    default:
      return nil
    }
  }

  private func smartArrivalWouldNotifyDetail(
    walkingStartedAt: String,
    decisionAt: String,
    elapsedSeconds: Double,
    priorAutomotive: PriorAutomotiveEvidence?,
    freshLocation: PersistedArrivalDiagnosticEvent?,
    remainingDeadlineSeconds: Double?,
    backgroundTaskActive: Bool,
    observationReconstructed: Bool
  ) -> String {
    var detail =
      "radiusMeters=\(radiusText(ArrivalDiagnosticConstants.radiusMeters));walkingStartedAt=\(walkingStartedAt);decisionAt=\(decisionAt);elapsedSeconds=\(measurementText(elapsedSeconds))"
    if let priorAutomotive {
      detail +=
        ";priorAutomotiveStart=\(priorAutomotive.activityStartedAt);priorAutomotiveConfidence=\(priorAutomotive.confidence);priorAutomotiveSource=\(priorAutomotive.source)"
    } else {
      detail += ";priorAutomotive=none"
    }
    if let freshLocation,
      let distance = freshLocation.distanceFromStoreMeters,
      let accuracy = freshLocation.horizontalAccuracyMeters,
      let age = freshLocation.sampleAgeSeconds
    {
      let speed = freshLocation.speedMetersPerSecond.map(measurementText)
        ?? "unavailable"
      detail +=
        ";distanceMeters=\(measurementText(distance));speedMetersPerSecond=\(speed);horizontalAccuracyMeters=\(measurementText(accuracy));sampleAgeSeconds=\(measurementText(age))"
    } else {
      detail += ";locationSample=none"
    }
    if let remainingDeadlineSeconds {
      detail +=
        ";remainingDeadlineSeconds=\(measurementText(remainingDeadlineSeconds))"
    }
    detail +=
      ";backgroundTaskActive=\(backgroundTaskActive);observationReconstructed=\(observationReconstructed)"
    return detail
  }

  private func maybeRecordDriveAwayWouldEnd() {
    guard let observationIdentifier = state.activeObservationIdentifier else {
      return
    }
    guard !hasDriveAwayDecision(for: observationIdentifier) else {
      return
    }
    guard
      let evidence = firstDriveAwayEvidence(
        observationIdentifier: observationIdentifier
      )
    else {
      return
    }

    let elapsed = activeObservationDuration(at: Date()) ?? 0
    let location = evidence.location
    appendEvent(
      type: "drive-away-would-end",
      detail: driveAwayWouldEndDetail(
        location: location,
        closestDistanceMeters: evidence.closestDistanceMeters,
        elapsedSeconds: elapsed,
        automotiveStartedAt: evidence.automotiveStartedAt
      ),
      locationTimestamp: location.locationTimestamp,
      horizontalAccuracyMeters: location.horizontalAccuracyMeters,
      speedMetersPerSecond: location.speedMetersPerSecond,
      speedAccuracyMetersPerSecond: location.speedAccuracyMetersPerSecond,
      distanceFromStoreMeters: location.distanceFromStoreMeters,
      sampleAgeSeconds: location.sampleAgeSeconds,
      isFreshLocation: true,
      executionDurationSeconds: elapsed,
      activityStartTimestamp: evidence.automotiveStartedAt,
      activityAutomotive: true,
      activityStationary: evidence.automotive.activityStationary,
      activityWalking: false,
      activityRunning: evidence.automotive.activityRunning,
      activityUnknown: evidence.automotive.activityUnknown,
      activityCycling: evidence.automotive.activityCycling,
      activityConfidence: "high",
      observationIdentifier: observationIdentifier
    )
  }

  private func hasDriveAwayDecision(for observationIdentifier: String) -> Bool {
    state.events.contains {
      $0.type == "drive-away-would-end"
        && $0.observationIdentifier == observationIdentifier
    }
  }

  private struct DriveAwayEvidence {
    let location: PersistedArrivalDiagnosticEvent
    let closestDistanceMeters: Double
    let automotive: PersistedArrivalDiagnosticEvent
    let automotiveStartedAt: String
  }

  private func firstDriveAwayEvidence(
    observationIdentifier: String
  ) -> DriveAwayEvidence? {
    guard
      let automotive = latestDriveAwayAutomotive(
        observationIdentifier: observationIdentifier
      ),
      let automotiveStartedAt = automotive.activityStartTimestamp
    else {
      return nil
    }

    for event in state.events {
      guard
        event.observationIdentifier == observationIdentifier,
        driveAwayLocationQualifies(event),
        let distance = event.distanceFromStoreMeters,
        let closest = closestAccurateDistanceMeters(
          observationIdentifier: observationIdentifier,
          beforeSequence: event.sequence
        ),
        distance >=
          closest + ArrivalDiagnosticConstants.driveAwayDistanceIncreaseMeters
      else {
        continue
      }
      return DriveAwayEvidence(
        location: event,
        closestDistanceMeters: closest,
        automotive: automotive,
        automotiveStartedAt: automotiveStartedAt
      )
    }
    return nil
  }

  private func latestDriveAwayAutomotive(
    observationIdentifier: String
  ) -> PersistedArrivalDiagnosticEvent? {
    guard
      let observationStartedValue = state.observationStartedAt,
      let observationStartedAt = parseTimestamp(observationStartedValue)
    else {
      return nil
    }

    var selected: (start: Date, event: PersistedArrivalDiagnosticEvent)?
    for event in state.events {
      guard
        event.observationIdentifier == observationIdentifier,
        event.type == "activity-classification",
        event.activityAutomotive == true,
        event.activityWalking != true,
        event.activityConfidence == "high",
        let startValue = event.activityStartTimestamp,
        let start = parseTimestamp(startValue),
        start >= observationStartedAt,
        let source = activityDetailSource(event.detail),
        source == "live" || source == "historical-query"
      else {
        continue
      }
      if let selected, start < selected.start {
        continue
      }
      selected = (start, event)
    }
    return selected?.event
  }

  private func driveAwayLocationQualifies(
    _ event: PersistedArrivalDiagnosticEvent
  ) -> Bool {
    guard
      event.type == "live-location-update",
      event.isFreshLocation == true,
      let accuracy = event.horizontalAccuracyMeters,
      accuracy >= 0,
      accuracy <=
        ArrivalDiagnosticConstants.driveAwayMaximumHorizontalAccuracyMeters,
      let speed = event.speedMetersPerSecond,
      speed >= ArrivalDiagnosticConstants.driveAwayMinimumSpeedMetersPerSecond,
      let speedAccuracy = event.speedAccuracyMetersPerSecond,
      speedAccuracy >= 0,
      speedAccuracy <=
        ArrivalDiagnosticConstants.driveAwayMaximumSpeedAccuracyMetersPerSecond,
      let distance = event.distanceFromStoreMeters,
      distance >= ArrivalDiagnosticConstants.driveAwayMinimumDistanceMeters,
      let age = event.sampleAgeSeconds,
      age >= 0,
      age <= ArrivalDiagnosticConstants.freshLocationMaximumAgeSeconds
    else {
      return false
    }
    return true
  }

  private func closestAccurateDistanceMeters(
    observationIdentifier: String,
    beforeSequence sequence: Int
  ) -> Double? {
    var closest: Double?
    for event in state.events {
      guard
        event.observationIdentifier == observationIdentifier,
        event.type == "live-location-update",
        event.sequence < sequence,
        event.isFreshLocation == true,
        let accuracy = event.horizontalAccuracyMeters,
        accuracy >= 0,
        accuracy <=
          ArrivalDiagnosticConstants.driveAwayMaximumHorizontalAccuracyMeters,
        let distance = event.distanceFromStoreMeters,
        distance >= 0,
        let age = event.sampleAgeSeconds,
        age >= 0,
        age <= ArrivalDiagnosticConstants.freshLocationMaximumAgeSeconds
      else {
        continue
      }
      if closest == nil || distance < closest ?? .infinity {
        closest = distance
      }
    }
    return closest
  }

  private func driveAwayWouldEndDetail(
    location: PersistedArrivalDiagnosticEvent,
    closestDistanceMeters: Double,
    elapsedSeconds: Double,
    automotiveStartedAt: String
  ) -> String {
    let distance = location.distanceFromStoreMeters ?? 0
    let speed = location.speedMetersPerSecond ?? 0
    let accuracy = location.horizontalAccuracyMeters ?? 0
    let speedAccuracy = location.speedAccuracyMetersPerSecond ?? 0
    let age = location.sampleAgeSeconds ?? 0
    return [
      "distanceMeters=\(measurementText(distance))",
      "closestDistanceMeters=\(measurementText(closestDistanceMeters))",
      "distanceIncreaseMeters=\(measurementText(distance - closestDistanceMeters))",
      "speedMetersPerSecond=\(measurementText(speed))",
      "horizontalAccuracyMeters=\(measurementText(accuracy))",
      "speedAccuracyMetersPerSecond=\(measurementText(speedAccuracy))",
      "sampleAgeSeconds=\(measurementText(age))",
      "elapsedSeconds=\(measurementText(elapsedSeconds))",
      "automotiveStartedAt=\(automotiveStartedAt)",
    ].joined(separator: ";")
  }

  private func latestFreshLocationEvent(
    observationIdentifier: String
  ) -> PersistedArrivalDiagnosticEvent? {
    state.events.last {
      $0.observationIdentifier == observationIdentifier
        && $0.type == "live-location-update"
        && $0.isFreshLocation == true
    }
  }

  private func observationWasReconstructed(
    _ observationIdentifier: String
  ) -> Bool {
    state.events.contains {
      $0.type == "live-observation-reconstructed"
        && $0.observationIdentifier == observationIdentifier
    }
  }

  private func remainingDeadlineSeconds(at date: Date) -> Double? {
    guard
      let value = state.observationDeadline,
      let deadline = parseTimestamp(value)
    else {
      return nil
    }
    return max(0, deadline.timeIntervalSince(date))
  }

  private func measurementText(_ value: Double) -> String {
    String(
      format: "%.3f",
      locale: Locale(identifier: "en_US_POSIX"),
      value
    )
  }

  private func activityKey(_ activity: CMMotionActivity) -> String {
    let flags = [
      activity.automotive,
      activity.stationary,
      activity.walking,
      activity.running,
      activity.cycling,
      activity.unknown,
    ].map { $0 ? "1" : "0" }.joined()
    return "\(timestamp(activity.startDate))-\(flags)-\(activityConfidenceName(activity.confidence))"
  }

  private func motionAuthorizationStatusName() -> String {
    guard CMMotionActivityManager.isActivityAvailable() else {
      return "unavailable"
    }
    return motionAuthorizationName(CMMotionActivityManager.authorizationStatus())
  }

  private func motionAuthorizationName(
    _ status: CMAuthorizationStatus
  ) -> String {
    switch status {
    case .notDetermined:
      return "not-determined"
    case .restricted:
      return "restricted"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    @unknown default:
      return "unknown"
    }
  }

  private func activityConfidenceName(
    _ confidence: CMMotionActivityConfidence
  ) -> String {
    switch confidence {
    case .low:
      return "low"
    case .medium:
      return "medium"
    case .high:
      return "high"
    @unknown default:
      return "unknown"
    }
  }
}

public class ThereYouGoArrivalDiagnosticAppDelegateSubscriber:
  ExpoAppDelegateSubscriber
{
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions:
      [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    ThereYouGoArrivalDiagnostic.shared.handleLaunch(
      launchedForLocation: launchOptions?[.location] != nil
    )
    return true
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    ThereYouGoArrivalDiagnostic.shared.handleDidEnterBackground()
  }

  public func applicationWillEnterForeground(_ application: UIApplication) {
    ThereYouGoArrivalDiagnostic.shared.handleWillEnterForeground()
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    ThereYouGoArrivalDiagnostic.shared.handleDidBecomeActive()
  }

  public func applicationWillTerminate(_ application: UIApplication) {
    ThereYouGoArrivalDiagnostic.shared.handleWillTerminate()
  }
}
