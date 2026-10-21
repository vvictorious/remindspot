import CoreLocation
import CoreMotion
import Foundation
import UIKit
import UserNotifications

private enum HistoricalMotionQuery {
  case failed
  case empty
  case activities([CMMotionActivity])
}

enum SmartArrivalRuntimeConstants {
  static let historicalLookbackSeconds = 120.0
  static let maximumHistoricalActivities = 16
  static let regionCoordinateTolerance = 0.000_001
  static let regionRadiusToleranceMeters = 0.01
}

struct PendingSmartArrivalRegion: Sendable {
  let installationId: String
  let location: PersistedCoordinate
}

struct SmartArrivalObservationEligibility: Sendable {
  let missingRequirements: [String]

  var canRegisterRegions: Bool {
    !missingRequirements.contains("ios-version") &&
      !missingRequirements.contains("region-monitoring")
  }

  var canObserve: Bool {
    missingRequirements.isEmpty
  }
}

@available(iOS 18.0, *)
private final class SmartArrivalModernRuntime {
  var serviceSession: CLServiceSession?
  var serviceDiagnosticsTask: Task<Void, Never>?
  var liveUpdatesTask: Task<Void, Never>?
}

@MainActor
final class ThereYouGoSmartArrivalRuntime:
  NSObject, @preconcurrency CLLocationManagerDelegate
{
  static let shared = ThereYouGoSmartArrivalRuntime()

  private let motionCallbackQueue = OperationQueue()
  private var locationManager: CLLocationManager?
  private var motionManager: CMMotionActivityManager?
  private var modernRuntime: AnyObject?
  private var observationDeadlineTask: Task<Void, Never>?
  private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
  private var motionUpdatesActive = false
  private var latestLocation: SmartArrivalLocationEvidence?
  private var recordedActivityKeys = Set<String>()
  private var streamsStarted = false
  private var lastObservationCount = 0
  private var historicalMotionTask: Task<Void, Never>?
  private var foregroundPermissionTask: Task<Void, Never>?
  private var monitoringFailures: [String: String] = [:]

  private override init() {
    super.init()
    motionCallbackQueue.name = "ThereYouGoSmartArrivalMotion"
    motionCallbackQueue.maxConcurrentOperationCount = 1
  }

  var isRuntimeEligible: Bool {
    if #available(iOS 18.0, *) {
      return CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self)
    }
    return false
  }

  func monitoredManagedRegions() -> [CLCircularRegion] {
    ensureLocationManager()
    return (locationManager?.monitoredRegions ?? [])
      .compactMap { $0 as? CLCircularRegion }
      .filter { isManagedIdentifier($0.identifier) }
      .sorted { $0.identifier < $1.identifier }
  }

  func monitoredRegion(identifier: String) -> CLCircularRegion? {
    ensureLocationManager()
    return locationManager?.monitoredRegions
      .compactMap { $0 as? CLCircularRegion }
      .first { $0.identifier == identifier }
  }

  func occupiedIdentifiers(
    pendingNotificationIdentifiers: [String]
  ) -> Set<String> {
    ensureLocationManager()
    let monitored = locationManager?.monitoredRegions.map(\.identifier) ?? []
    return Set(pendingNotificationIdentifiers + monitored)
  }

  func startMonitoring(
    desired: DesiredStoreNotification,
    installationId: String
  ) -> CLCircularRegion? {
    guard isRuntimeEligible else {
      return nil
    }
    ensureLocationManager()
    guard let locationManager else {
      return nil
    }

    let region = makeRegion(
      installationId: installationId,
      location: desired.location
    )
    if let existing = monitoredRegion(identifier: installationId),
      regionsMatch(existing, desired: desired)
    {
      return existing
    }

    locationManager.startMonitoring(for: region)
    return monitoredRegion(identifier: installationId)
  }

  func startMonitoring(
    descriptor: PendingSmartArrivalRegion,
    pendingLocationNotificationIdentifiers: [String]
  ) -> CLCircularRegion? {
    guard isRuntimeEligible else {
      return nil
    }
    ensureLocationManager()
    guard let locationManager else {
      return nil
    }

    let region = makeRegion(
      installationId: descriptor.installationId,
      location: descriptor.location
    )
    if monitoredRegion(identifier: descriptor.installationId) != nil {
      return monitoredRegion(identifier: descriptor.installationId)
    }

    let occupied = occupiedIdentifiers(
      pendingNotificationIdentifiers: pendingLocationNotificationIdentifiers
    )
    if !occupied.contains(descriptor.installationId),
      occupied.count >= GeofenceNotificationConstants.maximumLocationTriggers
    {
      return nil
    }

    locationManager.startMonitoring(for: region)
    return monitoredRegion(identifier: descriptor.installationId)
  }

  func stopMonitoring(identifier: String) -> Bool {
    guard isManagedIdentifier(identifier) else {
      return true
    }
    ensureLocationManager()
    guard let locationManager else {
      return true
    }
    guard let region = monitoredRegion(identifier: identifier) else {
      return true
    }
    locationManager.stopMonitoring(for: region)
    return monitoredRegion(identifier: identifier) == nil
  }

  func handleLaunch(launchedForLocation: Bool) {
    ensureLocationManager()
    Task {
      await ThereYouGoLocationNotificationReconciler.shared.recoverOnLaunch(
        launchedForLocation: launchedForLocation
      )
      await syncToPersistedObservations(reconstructed: true)
    }
  }

  func handleDidBecomeActive() {
    guard isRuntimeEligible else {
      return
    }
    Task {
      await requestForegroundPermissionsIfNeeded()
      await ThereYouGoLocationNotificationReconciler.shared
        .recoverPersistedArrivals()
      await syncToPersistedObservations(reconstructed: false)
    }
  }

  func requestForegroundPermissionsIfNeeded() async {
    if let foregroundPermissionTask {
      await foregroundPermissionTask.value
      return
    }
    guard UIApplication.shared.applicationState == .active else {
      return
    }
    let task = Task { @MainActor [weak self] in
      guard let self else {
        return
      }
      await self.performForegroundPermissionRequest()
    }
    foregroundPermissionTask = task
    await task.value
    foregroundPermissionTask = nil
  }

  func observationEligibility() async -> SmartArrivalObservationEligibility {
    var missing: [String] = []
    if ProcessInfo.processInfo.operatingSystemVersion.majorVersion < 18 {
      missing.append("ios-version")
    }
    if !CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) {
      missing.append("region-monitoring")
    }
    ensureLocationManager()
    if locationManager?.authorizationStatus != .authorizedAlways {
      missing.append("always-location")
    }
    if locationManager?.accuracyAuthorization != .fullAccuracy {
      missing.append("precise-location")
    }
    if
      !CMMotionActivityManager.isActivityAvailable() ||
      CMMotionActivityManager.authorizationStatus() != .authorized
    {
      missing.append("motion")
    }
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
      break
    default:
      missing.append("notifications")
    }
    return SmartArrivalObservationEligibility(missingRequirements: missing)
  }

  func takeMonitoringFailure(identifier: String) -> String? {
    monitoringFailures.removeValue(forKey: identifier)
  }

  func clearMonitoringFailure(identifier: String) {
    monitoringFailures.removeValue(forKey: identifier)
  }

  func syncToPersistedObservations(reconstructed: Bool = false) async {
    let eligibility = await observationEligibility()
    let snapshot =
      await ThereYouGoLocationNotificationReconciler.shared
      .observationRuntimeSnapshot(at: Date())
    if !eligibility.canObserve || snapshot.observationCount == 0 {
      lastObservationCount = 0
      stopSharedStreams()
      updateServiceSession(shouldRetain: snapshot.shouldRetainServiceSession)
      return
    }

    let shouldQueryHistory = snapshot.observationCount > lastObservationCount
    lastObservationCount = snapshot.observationCount
    beginSetupBackgroundTask()
    if streamsStarted {
      if shouldQueryHistory {
        historicalMotionTask?.cancel()
        historicalMotionTask = Task { [weak self] in
          guard let self else {
            return
          }
          await self.queryHistoricalMotion()
        }
      }
    } else {
      startSharedStreams(reconstructed: reconstructed)
    }
    startDeadlineTimer(deadline: snapshot.nextDeadline)
    updateServiceSession(shouldRetain: snapshot.shouldRetainServiceSession)
  }

  func locationManager(
    _ manager: CLLocationManager,
    didEnterRegion region: CLRegion
  ) {
    guard isManagedIdentifier(region.identifier), isRuntimeEligible else {
      return
    }
    beginSetupBackgroundTask()
    Task {
      await ThereYouGoLocationNotificationReconciler.shared.regionEntered(
        installationId: region.identifier,
        at: Date()
      )
      await syncToPersistedObservations(reconstructed: false)
    }
  }

  func locationManager(
    _ manager: CLLocationManager,
    didChangeAuthorization status: CLAuthorizationStatus
  ) {
    Task {
      await ThereYouGoLocationNotificationReconciler.shared
        .recoverPersistedArrivals()
      await syncToPersistedObservations(reconstructed: false)
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    Task {
      await ThereYouGoLocationNotificationReconciler.shared
        .recoverPersistedArrivals()
      await syncToPersistedObservations(reconstructed: false)
    }
  }

  func locationManager(
    _ manager: CLLocationManager,
    monitoringDidFailFor region: CLRegion?,
    withError error: Error
  ) {
    let message = String(error.localizedDescription.prefix(180))
    guard let identifier = region?.identifier else {
      monitoringFailures["*"] = message
      return
    }
    guard isManagedIdentifier(identifier) else {
      return
    }
    monitoringFailures[identifier] = message
    if let monitored = monitoredRegion(identifier: identifier) {
      manager.stopMonitoring(for: monitored)
    }
  }

  private func startSharedStreams(reconstructed: Bool) {
    guard #available(iOS 18.0, *) else {
      return
    }
    if streamsStarted {
      return
    }
    streamsStarted = true
    startLiveUpdates(reconstructed: reconstructed)
    startMotionCapture()
  }

  private func stopSharedStreams() {
    if #available(iOS 18.0, *),
      let runtime = modernRuntime as? SmartArrivalModernRuntime
    {
      runtime.liveUpdatesTask?.cancel()
      runtime.liveUpdatesTask = nil
    }
    historicalMotionTask?.cancel()
    historicalMotionTask = nil
    observationDeadlineTask?.cancel()
    observationDeadlineTask = nil
    stopMotionUpdates()
    streamsStarted = false
    latestLocation = nil
    recordedActivityKeys.removeAll()
    endSetupBackgroundTask()
  }

  @available(iOS 18.0, *)
  private func startLiveUpdates(reconstructed: Bool) {
    establishServiceSession(reconstructed: reconstructed)
    let runtime: SmartArrivalModernRuntime
    if let existing = modernRuntime as? SmartArrivalModernRuntime {
      runtime = existing
    } else {
      runtime = SmartArrivalModernRuntime()
      modernRuntime = runtime
    }

    runtime.liveUpdatesTask?.cancel()
    runtime.liveUpdatesTask = Task { @MainActor [weak self] in
      do {
        for try await update in CLLocationUpdate.liveUpdates() {
          guard !Task.isCancelled else {
            return
          }
          self?.handleLiveUpdate(update)
        }
        await self?.restartLiveUpdatesIfNeeded()
      } catch is CancellationError {
        return
      } catch {
        await self?.restartLiveUpdatesIfNeeded()
      }
    }
  }

  @available(iOS 18.0, *)
  private func handleLiveUpdate(_ update: CLLocationUpdate) {
    guard let location = update.location else {
      return
    }
    let now = Date()
    let evidence = SmartArrivalLocationEvidence(
      timestamp: location.timestamp,
      receivedAt: now,
      coordinate: PersistedCoordinate(
        latitude: location.coordinate.latitude,
        longitude: location.coordinate.longitude
      ),
      horizontalAccuracyMeters: location.horizontalAccuracy,
      speedMetersPerSecond: validMeasurement(location.speed),
      speedAccuracyMetersPerSecond: validMeasurement(location.speedAccuracy)
    )
    latestLocation = evidence
    Task {
      await ThereYouGoLocationNotificationReconciler.shared.applyLocation(
        evidence
      )
      await self.syncToPersistedObservations(reconstructed: false)
    }
  }

  @available(iOS 18.0, *)
  private func restartLiveUpdatesIfNeeded() async {
    guard streamsStarted else {
      return
    }
    startLiveUpdates(reconstructed: true)
  }

  private func startMotionCapture() {
    guard
      CMMotionActivityManager.isActivityAvailable(),
      CMMotionActivityManager.authorizationStatus() == .authorized
    else {
      return
    }
    startMotionUpdatesIfAuthorized()
    historicalMotionTask?.cancel()
    historicalMotionTask = Task { [weak self] in
      guard let self else {
        return
      }
      await self.queryHistoricalMotion()
    }
  }

  private func startMotionUpdatesIfAuthorized() {
    guard
      CMMotionActivityManager.isActivityAvailable(),
      CMMotionActivityManager.authorizationStatus() == .authorized,
      !motionUpdatesActive
    else {
      return
    }
    ensureMotionManager()
    motionManager?.startActivityUpdates(to: motionCallbackQueue) {
      [weak self] activity in
      guard let activity else {
        return
      }
      Task { @MainActor in
        self?.handleMotionActivity(activity, source: .live)
      }
    }
    motionUpdatesActive = true
  }

  private func stopMotionUpdates() {
    motionManager?.stopActivityUpdates()
    motionUpdatesActive = false
  }

  private func promptMotionAuthorizationIfNeeded() async {
    guard
      UIApplication.shared.applicationState == .active,
      CMMotionActivityManager.isActivityAvailable(),
      CMMotionActivityManager.authorizationStatus() == .notDetermined
    else {
      return
    }
    ensureMotionManager()
    guard let motionManager else {
      return
    }
    _ = await fetchHistoricalActivities(
      using: motionManager,
      from: Date().addingTimeInterval(-1),
      to: Date()
    )
  }

  private func queryHistoricalMotion() async {
    guard
      streamsStarted,
      !Task.isCancelled,
      CMMotionActivityManager.isActivityAvailable(),
      CMMotionActivityManager.authorizationStatus() == .authorized
    else {
      return
    }
    ensureMotionManager()
    guard let motionManager else {
      return
    }
    let queriedAt = Date()
    let fetched = await fetchHistoricalActivities(
      using: motionManager,
      from: queriedAt.addingTimeInterval(
        -SmartArrivalRuntimeConstants.historicalLookbackSeconds
      ),
      to: queriedAt
    )
    guard streamsStarted, !Task.isCancelled else {
      return
    }
    guard case .activities(let activities) = fetched else {
      return
    }
    let sorted = activities.sorted { $0.startDate < $1.startDate }
    let recent = Array(
      sorted.suffix(SmartArrivalRuntimeConstants.maximumHistoricalActivities)
    )
    for activity in recent {
      handleMotionActivity(activity, source: .historicalQuery)
    }
    guard
      await ThereYouGoLocationNotificationReconciler.shared
        .activeObservationContains(queriedAt),
      let current = sorted.last(where: { $0.startDate <= queriedAt })
    else {
      return
    }
    // This sample is the activity in effect at the query endpoint. It bypasses
    // dedup so an unchanged walk can reach an observation that started later.
    submitMotionEvidence(current, source: .live, receivedAt: queriedAt)
  }

  private func handleMotionActivity(
    _ activity: CMMotionActivity,
    source: SmartArrivalMotionSource
  ) {
    guard streamsStarted else {
      return
    }
    let key = activityKey(activity, source: source)
    if !recordedActivityKeys.insert(key).inserted {
      return
    }
    submitMotionEvidence(activity, source: source)
  }

  private func submitMotionEvidence(
    _ activity: CMMotionActivity,
    source: SmartArrivalMotionSource,
    receivedAt: Date = Date()
  ) {
    let evidence = SmartArrivalMotionEvidence(
      source: source,
      receivedAt: receivedAt,
      activityStartedAt: activity.startDate,
      automotive: activity.automotive,
      walking: activity.walking,
      confidence: motionConfidence(activity.confidence)
    )
    Task {
      await ThereYouGoLocationNotificationReconciler.shared.applyMotion(
        evidence,
        latestLocation: self.latestLocation
      )
      await self.syncToPersistedObservations(reconstructed: false)
    }
  }

  private func fetchHistoricalActivities(
    using motionManager: CMMotionActivityManager,
    from start: Date,
    to end: Date
  ) async -> HistoricalMotionQuery {
    await withCheckedContinuation { continuation in
      motionManager.queryActivityStarting(
        from: start,
        to: end,
        to: motionCallbackQueue
      ) { activities, error in
        if error != nil {
          continuation.resume(returning: .failed)
          return
        }
        let activities = activities ?? []
        guard !activities.isEmpty else {
          continuation.resume(returning: .empty)
          return
        }
        continuation.resume(returning: .activities(activities))
      }
    }
  }

  private func startDeadlineTimer(deadline: Date?) {
    observationDeadlineTask?.cancel()
    guard let deadline else {
      observationDeadlineTask = nil
      return
    }
    observationDeadlineTask = Task { @MainActor [weak self] in
      let remaining = max(0, deadline.timeIntervalSinceNow)
      let nanoseconds = UInt64(remaining * 1_000_000_000)
      try? await Task.sleep(nanoseconds: nanoseconds)
      guard !Task.isCancelled else {
        return
      }
      await self?.syncToPersistedObservations(reconstructed: false)
    }
  }

  private func updateServiceSession(shouldRetain: Bool) {
    guard #available(iOS 18.0, *) else {
      return
    }
    guard shouldRetain, hasAlwaysPreciseAuthorization else {
      invalidateServiceSession()
      return
    }
    establishServiceSession(reconstructed: false)
  }

  @available(iOS 18.0, *)
  private func establishServiceSession(reconstructed: Bool) {
    guard
      let locationManager,
      locationManager.authorizationStatus == .authorizedAlways,
      locationManager.accuracyAuthorization == .fullAccuracy
    else {
      return
    }

    let runtime: SmartArrivalModernRuntime
    if let existing = modernRuntime as? SmartArrivalModernRuntime {
      runtime = existing
    } else {
      runtime = SmartArrivalModernRuntime()
      modernRuntime = runtime
    }
    guard runtime.serviceSession == nil else {
      return
    }

    let session = CLServiceSession(authorization: .always)
    runtime.serviceSession = session
    runtime.serviceDiagnosticsTask = Task { @MainActor [weak self] in
      do {
        for try await diagnostic in session.diagnostics {
          guard !Task.isCancelled else {
            return
          }
          if diagnostic.authorizationDenied
            || diagnostic.authorizationDeniedGlobally
            || diagnostic.authorizationRestricted
            || diagnostic.fullAccuracyDenied
            || diagnostic.alwaysAuthorizationDenied
          {
            await self?.syncToPersistedObservations(reconstructed: false)
          }
        }
      } catch {
        return
      }
    }
    _ = reconstructed
  }

  private func invalidateServiceSession() {
    guard #available(iOS 18.0, *) else {
      modernRuntime = nil
      return
    }
    guard let runtime = modernRuntime as? SmartArrivalModernRuntime else {
      return
    }
    runtime.serviceDiagnosticsTask?.cancel()
    runtime.serviceDiagnosticsTask = nil
    runtime.serviceSession?.invalidate()
    runtime.serviceSession = nil
    if runtime.liveUpdatesTask == nil {
      modernRuntime = nil
    }
  }

  private func beginSetupBackgroundTask() {
    endSetupBackgroundTask()
    backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(
      withName: "ThereYouGoSmartArrivalSetup"
    ) { [weak self] in
      Task { @MainActor in
        self?.endSetupBackgroundTask()
      }
    }
  }

  private func endSetupBackgroundTask() {
    guard backgroundTaskIdentifier != .invalid else {
      return
    }
    UIApplication.shared.endBackgroundTask(backgroundTaskIdentifier)
    backgroundTaskIdentifier = .invalid
  }

  private func performForegroundPermissionRequest() async {
    guard UIApplication.shared.applicationState == .active else {
      return
    }
    ensureLocationManager()
    switch locationManager?.authorizationStatus {
    case .notDetermined, .authorizedWhenInUse:
      locationManager?.requestAlwaysAuthorization()
    default:
      break
    }
    await promptMotionAuthorizationIfNeeded()
  }

  private var hasAlwaysPreciseAuthorization: Bool {
    guard let locationManager else {
      return false
    }
    return locationManager.authorizationStatus == .authorizedAlways &&
      locationManager.accuracyAuthorization == .fullAccuracy
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

  private func ensureMotionManager() {
    guard motionManager == nil else {
      return
    }
    motionManager = CMMotionActivityManager()
  }

  private func makeRegion(
    installationId: String,
    location: PersistedCoordinate
  ) -> CLCircularRegion {
    let region = CLCircularRegion(
      center: CLLocationCoordinate2D(
        latitude: location.latitude,
        longitude: location.longitude
      ),
      radius: GeofenceNotificationConstants.radiusMeters,
      identifier: installationId
    )
    region.notifyOnEntry = true
    region.notifyOnExit = false
    return region
  }

  private func regionsMatch(
    _ region: CLCircularRegion,
    desired: DesiredStoreNotification
  ) -> Bool {
    abs(region.center.latitude - desired.location.latitude)
      < SmartArrivalRuntimeConstants.regionCoordinateTolerance &&
      abs(region.center.longitude - desired.location.longitude)
        < SmartArrivalRuntimeConstants.regionCoordinateTolerance &&
      abs(region.radius - GeofenceNotificationConstants.radiusMeters)
        < SmartArrivalRuntimeConstants.regionRadiusToleranceMeters &&
      region.notifyOnEntry &&
      !region.notifyOnExit
  }

  private func isManagedIdentifier(_ identifier: String) -> Bool {
    identifier.hasPrefix(GeofenceNotificationConstants.managedIdentifierPrefix)
  }

  private func validMeasurement(_ value: Double) -> Double? {
    value >= 0 && value.isFinite ? value : nil
  }

  private func motionConfidence(
    _ confidence: CMMotionActivityConfidence
  ) -> SmartArrivalMotionConfidence {
    switch confidence {
    case .low:
      return .low
    case .medium:
      return .medium
    case .high:
      return .high
    @unknown default:
      return .low
    }
  }

  private func activityKey(
    _ activity: CMMotionActivity,
    source: SmartArrivalMotionSource
  ) -> String {
    let sourceLabel: String
    switch source {
    case .live:
      sourceLabel = "live"
    case .historicalQuery:
      sourceLabel = "historical"
    case .authorizationPrompt:
      sourceLabel = "prompt"
    }
    return [
      sourceLabel,
      String(activity.startDate.timeIntervalSince1970),
      activity.automotive ? "1" : "0",
      activity.walking ? "1" : "0",
      activity.automotive ? "a" : "",
      String(activity.confidence.rawValue)
    ].joined(separator: ":")
  }
}
