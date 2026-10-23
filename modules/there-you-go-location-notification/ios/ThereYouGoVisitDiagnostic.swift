#if DEBUG
import CoreLocation
import Foundation
import UIKit

// Temporary Milestone 8.1 CLVisit diagnostic. It is compiled into debug
// builds only and records visits locally. It does not register geofences,
// schedule notifications, or call Google Places.
//
// Remove this file, src/diagnostics/visit-diagnostic-console.ts, the debug
// subscriber hooks, and the four visit functions on the native module.

private enum VisitDiagnosticConstants {
  static let schemaVersion = 1
  static let maximumEvents = 200
  static let userDefaultsKey = "there-you-go.visit-diagnostic.v1"
  static let destinationName = "Mira's Film Lab"
  static let destinationLatitude = 33.99924
  static let destinationLongitude = -118.46298
}

private struct VisitDiagnosticDestination: Codable {
  let name: String
  let latitude: Double
  let longitude: Double
}

private struct VisitDiagnosticVisit: Codable {
  let kind: String
  let arrivalDate: String?
  let departureDate: String?
  let latencySeconds: Double?
  let latitude: Double
  let longitude: Double
  let horizontalAccuracyMeters: Double?
  let distanceFromTestDestinationMeters: Double?
}

private struct VisitDiagnosticEvent: Codable {
  let sequence: Int
  let type: String
  let receivedAt: String
  let processId: String
  let processAgeSeconds: Double
  let appState: String
  let launchedForLocation: Bool
  let authorizationStatus: String
  let accuracyAuthorization: String
  let backgroundRefreshStatus: String
  let lowPowerMode: Bool
  let detail: String?
  let visit: VisitDiagnosticVisit?
}

private struct PersistedVisitDiagnosticState: Codable {
  var schemaVersion: Int
  var isMonitoring: Bool
  var droppedEventCount: Int
  var events: [VisitDiagnosticEvent]

  static var empty: PersistedVisitDiagnosticState {
    PersistedVisitDiagnosticState(
      schemaVersion: VisitDiagnosticConstants.schemaVersion,
      isMonitoring: false,
      droppedEventCount: 0,
      events: []
    )
  }
}

private struct VisitDiagnosticSnapshot: Codable {
  let schemaVersion: Int
  let available: Bool
  let isMonitoring: Bool
  let droppedEventCount: Int
  let locationServicesEnabled: Bool
  let authorizationStatus: String
  let accuracyAuthorization: String
  let backgroundRefreshStatus: String
  let lowPowerMode: Bool
  let launchedForLocation: Bool
  let processId: String
  let testDestination: VisitDiagnosticDestination
  let events: [VisitDiagnosticEvent]
}

private enum VisitDiagnosticError: LocalizedError {
  case locationServicesDisabled
  case alwaysAuthorizationRequired(String)

  var errorDescription: String? {
    switch self {
    case .locationServicesDisabled:
      return "Location Services are disabled on this iPhone."
    case .alwaysAuthorizationRequired(let status):
      return "Visit monitoring needs existing Always location access (status: \(status))."
    }
  }
}

@MainActor
final class ThereYouGoVisitDiagnostic:
  NSObject, @preconcurrency CLLocationManagerDelegate
{
  static let shared = ThereYouGoVisitDiagnostic()

  private let encoder: JSONEncoder
  private let timestampFormatter: ISO8601DateFormatter
  private let testDestination: CLLocation
  private var locationManager: CLLocationManager?
  private var state: PersistedVisitDiagnosticState
  private let processId: String
  private let processStartedAt: Date
  private var launchedForLocation = false
  private var didHandleLaunch = false

  private override init() {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    self.encoder = encoder
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    self.timestampFormatter = formatter
    self.testDestination = CLLocation(
      latitude: VisitDiagnosticConstants.destinationLatitude,
      longitude: VisitDiagnosticConstants.destinationLongitude
    )
    self.state = Self.loadState()
    self.processId = UUID().uuidString.lowercased()
    self.processStartedAt = Date()
    super.init()
  }

  /// Restores visit monitoring once per process. Visit monitoring itself
  /// survives relaunch, but iOS only delivers the event if a delegate exists
  /// before `didFinishLaunching` returns.
  func handleLaunch(
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) {
    guard !didHandleLaunch else {
      return
    }
    didHandleLaunch = true
    launchedForLocation = launchOptions?[.location] != nil
    guard state.isMonitoring else {
      return
    }
    ensureLocationManager()
    locationManager?.startMonitoringVisits()
    appendEvent(
      type: "process-launch",
      detail: launchedForLocation ? "locationLaunch=true" : "locationLaunch=false"
    )
    appendEvent(type: "monitoring-started", detail: "origin=launch-restore")
  }

  func start() throws -> String {
    guard CLLocationManager.locationServicesEnabled() else {
      throw VisitDiagnosticError.locationServicesDisabled
    }
    ensureLocationManager()
    let status = locationManager?.authorizationStatus ?? .notDetermined
    guard status == .authorizedAlways else {
      throw VisitDiagnosticError.alwaysAuthorizationRequired(
        authorizationStatusName(status)
      )
    }
    if state.isMonitoring {
      locationManager?.startMonitoringVisits()
      return encodeSnapshot()
    }
    state.isMonitoring = true
    saveState()
    locationManager?.startMonitoringVisits()
    appendEvent(type: "monitoring-started", detail: "origin=console")
    return encodeSnapshot()
  }

  func stop() -> String {
    ensureLocationManager()
    locationManager?.stopMonitoringVisits()
    guard state.isMonitoring else {
      return encodeSnapshot()
    }
    state.isMonitoring = false
    appendEvent(type: "monitoring-stopped", detail: "origin=console")
    return encodeSnapshot()
  }

  func results() -> String {
    ensureLocationManager()
    return encodeSnapshot()
  }

  func clear() -> String {
    state.events = []
    state.droppedEventCount = 0
    saveState()
    ensureLocationManager()
    return encodeSnapshot()
  }

  func locationManager(
    _ manager: CLLocationManager,
    didVisit visit: CLVisit
  ) {
    guard state.isMonitoring else {
      return
    }
    let receivedAt = Date()
    appendEvent(
      type: "visit",
      detail: nil,
      visit: makeVisit(visit, receivedAt: receivedAt),
      receivedAt: receivedAt
    )
  }

  func locationManager(
    _ manager: CLLocationManager,
    didFailWithError error: Error
  ) {
    guard state.isMonitoring else {
      return
    }
    appendEvent(type: "location-error", detail: sanitizedError(error))
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard state.isMonitoring else {
      return
    }
    appendEvent(
      type: "authorization-changed",
      detail:
        "\(authorizationStatusName(manager.authorizationStatus))/\(accuracyAuthorizationName(manager.accuracyAuthorization))"
    )
  }

  private func ensureLocationManager() {
    guard locationManager == nil else {
      return
    }
    let manager = CLLocationManager()
    manager.delegate = self
    locationManager = manager
  }

  private func appendEvent(
    type: String,
    detail: String?,
    visit: VisitDiagnosticVisit? = nil,
    receivedAt: Date = Date()
  ) {
    let sequence = (state.events.last?.sequence ?? 0) + 1
    let manager = locationManager
    state.events.append(
      VisitDiagnosticEvent(
        sequence: sequence,
        type: type,
        receivedAt: timestamp(receivedAt),
        processId: processId,
        processAgeSeconds: rounded(
          max(0, receivedAt.timeIntervalSince(processStartedAt))
        ),
        appState: applicationStateName(UIApplication.shared.applicationState),
        launchedForLocation: launchedForLocation,
        authorizationStatus: authorizationStatusName(
          manager?.authorizationStatus ?? .notDetermined
        ),
        accuracyAuthorization: accuracyAuthorizationName(
          manager?.accuracyAuthorization
        ),
        backgroundRefreshStatus: backgroundRefreshStatusName(
          UIApplication.shared.backgroundRefreshStatus
        ),
        lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
        detail: detail,
        visit: visit
      )
    )
    let overflow = state.events.count - VisitDiagnosticConstants.maximumEvents
    if overflow > 0 {
      state.droppedEventCount += overflow
      state.events.removeFirst(overflow)
    }
    saveState()
  }

  private func makeVisit(
    _ visit: CLVisit,
    receivedAt: Date
  ) -> VisitDiagnosticVisit {
    let arrivalKnown = visit.arrivalDate != Date.distantPast
    let departed = visit.departureDate != Date.distantFuture
    let kind: String
    if arrivalKnown && !departed {
      kind = "arrival"
    } else if arrivalKnown && departed {
      kind = "departure"
    } else if departed {
      kind = "departure-arrival-unknown"
    } else {
      kind = "arrival-unknown"
    }
    let latencyReference: Date?
    if departed {
      latencyReference = visit.departureDate
    } else if arrivalKnown {
      latencyReference = visit.arrivalDate
    } else {
      latencyReference = nil
    }
    let coordinate = visit.coordinate
    let coordinateIsValid = CLLocationCoordinate2DIsValid(coordinate)
    let distance = coordinateIsValid
      ? rounded(
        CLLocation(
          latitude: coordinate.latitude,
          longitude: coordinate.longitude
        ).distance(from: testDestination)
      )
      : nil
    return VisitDiagnosticVisit(
      kind: kind,
      arrivalDate: arrivalKnown ? timestamp(visit.arrivalDate) : nil,
      departureDate: departed ? timestamp(visit.departureDate) : nil,
      latencySeconds: latencyReference.map {
        rounded(receivedAt.timeIntervalSince($0))
      },
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      horizontalAccuracyMeters: visit.horizontalAccuracy >= 0
        ? rounded(visit.horizontalAccuracy)
        : nil,
      distanceFromTestDestinationMeters: distance
    )
  }

  private func encodeSnapshot() -> String {
    let manager = locationManager
    let snapshot = VisitDiagnosticSnapshot(
      schemaVersion: VisitDiagnosticConstants.schemaVersion,
      available: true,
      isMonitoring: state.isMonitoring,
      droppedEventCount: state.droppedEventCount,
      locationServicesEnabled: CLLocationManager.locationServicesEnabled(),
      authorizationStatus: authorizationStatusName(
        manager?.authorizationStatus ?? .notDetermined
      ),
      accuracyAuthorization: accuracyAuthorizationName(
        manager?.accuracyAuthorization
      ),
      backgroundRefreshStatus: backgroundRefreshStatusName(
        UIApplication.shared.backgroundRefreshStatus
      ),
      lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
      launchedForLocation: launchedForLocation,
      processId: processId,
      testDestination: VisitDiagnosticDestination(
        name: VisitDiagnosticConstants.destinationName,
        latitude: VisitDiagnosticConstants.destinationLatitude,
        longitude: VisitDiagnosticConstants.destinationLongitude
      ),
      events: state.events
    )
    guard
      let data = try? encoder.encode(snapshot),
      let text = String(data: data, encoding: .utf8)
    else {
      return #"{"schemaVersion":1,"available":true,"detail":"encode-failed","events":[]}"#
    }
    return text
  }

  private func saveState() {
    guard let data = try? encoder.encode(state) else {
      return
    }
    UserDefaults.standard.set(data, forKey: VisitDiagnosticConstants.userDefaultsKey)
  }

  private static func loadState() -> PersistedVisitDiagnosticState {
    guard
      let data = UserDefaults.standard.data(
        forKey: VisitDiagnosticConstants.userDefaultsKey
      ),
      let state = try? JSONDecoder().decode(
        PersistedVisitDiagnosticState.self,
        from: data
      ),
      state.schemaVersion == VisitDiagnosticConstants.schemaVersion
    else {
      return .empty
    }
    return state
  }

  private func timestamp(_ date: Date) -> String {
    timestampFormatter.string(from: date)
  }

  private func rounded(_ value: Double) -> Double {
    (value * 1000).rounded() / 1000
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
}
#endif
