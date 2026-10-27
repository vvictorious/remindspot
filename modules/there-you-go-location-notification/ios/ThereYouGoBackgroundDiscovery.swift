import CoreLocation
import Foundation
import UIKit

// Production CLVisit discovery. A visit can call the existing places API and
// reconcile a complete response without starting React Native. Failure leaves
// the persisted geofences in place.

struct BackgroundDiscoveryVisitSample {
  var arrivalDate: Date?
  var departureDate: Date?
  var latitude: Double
  var longitude: Double
  var horizontalAccuracy: Double
  var coordinateValid: Bool
}

private struct PersistedBackgroundDiscoveryItem: Codable {
  var id: String
  var revision: Int
  var text: String
  var taxonomyVersion: Int
  var categories: [String]
}

private struct PersistedBackgroundDiscoveryInput: Codable {
  var schemaVersion: Int
  var apiBaseUrl: String
  var items: [PersistedBackgroundDiscoveryItem]
  var updatedAt: String

  static let empty = PersistedBackgroundDiscoveryInput(
    schemaVersion: BackgroundDiscoveryPolicy.schemaVersion,
    apiBaseUrl: "",
    items: [],
    updatedAt: ""
  )
}

private struct PersistedBackgroundDiscoveryAttempt: Codable {
  var schemaVersion: Int
  var inFlightToken: String?
  var inFlightStartedAt: Double?
  var inFlightLatitude: Double?
  var inFlightLongitude: Double?
  var inFlightItemSignature: String?
  var lastArrivalKey: String?
  var lastFailureAt: Double?
  var lastFailureLatitude: Double?
  var lastFailureLongitude: Double?
  var lastFailureItemSignature: String?
  var successfulItemSignature: String?
  var successfulPlaceItemsSignature: String?
  var successfulGeneratedAt: String?

  static let empty = PersistedBackgroundDiscoveryAttempt(
    schemaVersion: BackgroundDiscoveryPolicy.schemaVersion,
    inFlightToken: nil,
    inFlightStartedAt: nil,
    inFlightLatitude: nil,
    inFlightLongitude: nil,
    inFlightItemSignature: nil,
    lastArrivalKey: nil,
    lastFailureAt: nil,
    lastFailureLatitude: nil,
    lastFailureLongitude: nil,
    lastFailureItemSignature: nil,
    successfulItemSignature: nil,
    successfulPlaceItemsSignature: nil,
    successfulGeneratedAt: nil
  )
}

struct BackgroundDiscoveryAnchorSnapshot {
  var generatedAt: String
  var latitude: Double
  var longitude: Double
  var itemSignature: String
  var placeItemsSignature: String
}

private enum BackgroundDiscoveryStorage {
  static let inputKey = "there-you-go.background-discovery.input.v1"
  static let attemptKey = "there-you-go.background-discovery.attempt.v1"
}

private final class BackgroundDiscoveryExecution: @unchecked Sendable {
  let token = UUID().uuidString.lowercased()
  private let lock = NSLock()
  private var expired = false
  private var ended = false
  private var networkFinished = false
  private var taskIdentifier = UIBackgroundTaskIdentifier.invalid
  private var networkTask: URLSessionTask?

  var isBlocked: Bool {
    lock.lock()
    defer { lock.unlock() }
    return expired
  }

  func begin() {
    // The expiration handler can run before beginBackgroundTask returns.
    // Keep the lock out of that call, then end the identifier here if it
    // already expired before it could be stored.
    let identifier = UIApplication.shared.beginBackgroundTask(
      withName: "ThereYouGoBackgroundDiscovery"
    ) { [weak self] in
      self?.expire()
    }
    lock.lock()
    let alreadyExpired = expired
    if !alreadyExpired {
      taskIdentifier = identifier
    }
    lock.unlock()
    if alreadyExpired, identifier != .invalid {
      UIApplication.shared.endBackgroundTask(identifier)
    }
  }

  func expire() {
    let task: URLSessionTask?
    let shouldRecord: Bool
    lock.lock()
    shouldRecord = !expired
    expired = true
    task = networkTask
    lock.unlock()
    task?.cancel()
    #if DEBUG
    if shouldRecord {
      BackgroundDiscoveryDevelopmentEventLog.record(
        type: "task-expired",
        detail: "execution-expired"
      )
    }
    #endif
    endBackgroundTaskOnce()
  }

  func response(
    for request: URLRequest,
    session: URLSession
  ) async throws -> (Data, HTTPURLResponse) {
    let result: (Data, URLResponse) = try await withCheckedThrowingContinuation {
      continuation in
      let task = session.dataTask(with: request) { data, response, error in
        self.complete(
          continuation,
          data: data,
          response: response,
          error: error
        )
      }
      lock.lock()
      let alreadyExpired = expired
      if !alreadyExpired {
        networkTask = task
      }
      lock.unlock()
      if alreadyExpired {
        task.cancel()
        complete(
          continuation,
          data: nil,
          response: nil,
          error: URLError(.cancelled)
        )
        return
      }
      task.resume()
    }
    guard let http = result.1 as? HTTPURLResponse else {
      throw URLError(.badServerResponse)
    }
    return (result.0, http)
  }

  func endBackgroundTaskOnce() {
    let identifier: UIBackgroundTaskIdentifier
    lock.lock()
    let shouldEnd = !ended && taskIdentifier != .invalid
    identifier = taskIdentifier
    ended = true
    taskIdentifier = .invalid
    lock.unlock()
    guard shouldEnd else {
      return
    }
    if Thread.isMainThread {
      UIApplication.shared.endBackgroundTask(identifier)
    } else {
      DispatchQueue.main.async {
        UIApplication.shared.endBackgroundTask(identifier)
      }
    }
  }

  private func complete(
    _ continuation: CheckedContinuation<(Data, URLResponse), Error>,
    data: Data?,
    response: URLResponse?,
    error: Error?
  ) {
    lock.lock()
    let alreadyFinished = networkFinished
    networkFinished = true
    lock.unlock()
    guard !alreadyFinished else {
      return
    }
    if let error {
      continuation.resume(throwing: error)
      return
    }
    guard let data, let response else {
      continuation.resume(throwing: URLError(.badServerResponse))
      return
    }
    continuation.resume(returning: (data, response))
  }
}

@MainActor
final class ThereYouGoBackgroundDiscovery {
  static let shared = ThereYouGoBackgroundDiscovery()

  private let session: URLSession
  private let encoder: JSONEncoder
  private var activeToken: String?

  private init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest =
      BackgroundDiscoveryPolicy.requestTimeoutSeconds
    configuration.timeoutIntervalForResource =
      BackgroundDiscoveryPolicy.requestTimeoutSeconds
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    self.encoder = encoder
  }

  func prepareMonitoring(origin: String) {
    let update = ThereYouGoSmartArrivalRuntime.shared.setVisitMonitoringDesired(
      !loadInput().items.isEmpty
    )
    #if DEBUG
    if origin.hasPrefix("launch") {
      record(
        type: update.isMonitoring ? "monitoring-started" : "monitoring-not-started",
        detail: "origin=\(origin);\(update.reason)"
      )
    } else if update.changed {
      record(
        type: update.isMonitoring ? "monitoring-started" : "monitoring-stopped",
        detail: "origin=\(origin);\(update.reason)"
      )
    }
    #endif
  }

  func refreshVisitMonitoring(origin: String) {
    prepareMonitoring(origin: origin)
  }

  func replaceInput(
    apiBaseUrl: String,
    items: [BackgroundDiscoveryPolicy.Item],
    updatedAt: String
  ) {
    var root = apiBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    while root.hasSuffix("/") {
      root.removeLast()
    }
    saveInput(
      PersistedBackgroundDiscoveryInput(
        schemaVersion: BackgroundDiscoveryPolicy.schemaVersion,
        apiBaseUrl: root,
        items: items.map {
          PersistedBackgroundDiscoveryItem(
            id: $0.id,
            revision: $0.revision,
            text: $0.text,
            taxonomyVersion: $0.taxonomyVersion,
            categories: $0.categories
          )
        },
        updatedAt: updatedAt
      )
    )
    refreshVisitMonitoring(origin: "input")
  }

  func noteAnchor(
    itemSignature: String,
    placeItemsSignature: String,
    generatedAt: String
  ) {
    guard CandidateSnapshotValidator.iso8601Date(generatedAt) != nil else {
      return
    }
    var attempt = loadAttempt()
    if let existing = attempt.successfulGeneratedAt,
      let existingDate = CandidateSnapshotValidator.iso8601Date(existing),
      let incomingDate = CandidateSnapshotValidator.iso8601Date(generatedAt),
      incomingDate < existingDate
    {
      return
    }
    attempt.successfulItemSignature = itemSignature
    attempt.successfulPlaceItemsSignature = placeItemsSignature
    attempt.successfulGeneratedAt = generatedAt
    saveAttempt(attempt)
  }

  func foregroundAnchor() -> BackgroundDiscoveryAnchorSnapshot? {
    guard
      let snapshot = loadGeofenceSnapshot(),
      let attempt = optionalAttempt(),
      attempt.successfulGeneratedAt == snapshot.generatedAt,
      let itemSignature = attempt.successfulItemSignature,
      let placeItemsSignature = attempt.successfulPlaceItemsSignature
    else {
      return nil
    }
    return BackgroundDiscoveryAnchorSnapshot(
      generatedAt: snapshot.generatedAt,
      latitude: snapshot.discoveryAnchor.latitude,
      longitude: snapshot.discoveryAnchor.longitude,
      itemSignature: itemSignature,
      placeItemsSignature: placeItemsSignature
    )
  }

  func handleVisit(
    _ sample: BackgroundDiscoveryVisitSample,
    allowForeground: Bool
  ) {
    let execution = BackgroundDiscoveryExecution()
    execution.begin()
    Task {
      _ = await self.process(
        sample,
        execution: execution,
        allowForeground: allowForeground
      )
    }
  }

  func simulateVisit(
    latitude: Double,
    longitude: Double,
    horizontalAccuracy: Double
  ) async -> String {
    let coordinate = CLLocationCoordinate2D(
      latitude: latitude,
      longitude: longitude
    )
    let execution = BackgroundDiscoveryExecution()
    execution.begin()
    return await process(
      BackgroundDiscoveryVisitSample(
        arrivalDate: Date(),
        departureDate: nil,
        latitude: latitude,
        longitude: longitude,
        horizontalAccuracy: horizontalAccuracy,
        coordinateValid: CLLocationCoordinate2DIsValid(coordinate)
      ),
      execution: execution,
      allowForeground: true
    )
  }

  func debugValidationJSON() -> String {
    #if DEBUG
    let failures = BackgroundDiscoveryPolicyValidation.failures()
    let encodedFailures = failures.map { "\"\(escapeJSON($0))\"" }.joined(separator: ",")
    return """
    {"passed":\(failures.isEmpty),"failures":[\(encodedFailures)]}
    """
    #else
    return #"{"passed":false,"failures":["debug-build-required"]}"#
    #endif
  }

  private func process(
    _ sample: BackgroundDiscoveryVisitSample,
    execution: BackgroundDiscoveryExecution,
    allowForeground: Bool
  ) async -> String {
    defer {
      if activeToken == execution.token {
        activeToken = nil
        var attempt = loadAttempt()
        if attempt.inFlightToken == execution.token {
          attempt.inFlightToken = nil
          attempt.inFlightStartedAt = nil
          attempt.inFlightLatitude = nil
          attempt.inFlightLongitude = nil
          attempt.inFlightItemSignature = nil
          saveAttempt(attempt)
        }
      }
      execution.endBackgroundTaskOnce()
    }

    let startedAt = Date()
    let input = loadInput()
    let storedAttempt = loadAttempt()
    let geofenceSnapshot = loadGeofenceSnapshot()
    let items = policyItems(input)
    let authorization = ThereYouGoSmartArrivalRuntime.shared.locationAuthorization()
    let anchor = decisionAnchor(
      snapshot: geofenceSnapshot,
      attempt: storedAttempt
    )
    record(
      type: "visit-received",
      detail: visitDetail(sample),
      accuracyMeters: sample.horizontalAccuracy,
      distanceFromAnchorMeters: anchor.map {
        BackgroundDiscoveryPolicy.distanceMeters(
          latitude: sample.latitude,
          longitude: sample.longitude,
          otherLatitude: $0.latitude,
          otherLongitude: $0.longitude
        )
      }
    )

    let decision = BackgroundDiscoveryPolicy.decide(
      BackgroundDiscoveryPolicy.DecisionInput(
        now: startedAt,
        appState: applicationStateName(),
        allowForeground: allowForeground,
        authorization: authorization.alwaysPrecise ? "always-precise" : "unavailable",
        arrivalKnown: sample.arrivalDate != nil,
        departed: sample.departureDate != nil,
        coordinateValid: sample.coordinateValid,
        latitude: sample.latitude,
        longitude: sample.longitude,
        arrivalKey: arrivalKey(sample),
        items: items,
        apiBaseUrl: input.apiBaseUrl,
        attempt: policyAttempt(storedAttempt),
        anchor: anchor
      )
    )

    if case .skip(let reason) = decision {
      if reason == "unchanged-nearby-anchor" || reason == "failure-cooldown" {
        var attempt = loadAttempt()
        attempt.lastArrivalKey = arrivalKey(sample)
        saveAttempt(attempt)
      }
      record(type: "discovery-skipped", detail: reason, accuracyMeters: sample.horizontalAccuracy)
      return #"{"outcome":"skipped","detail":"\#(reason)"}"#
    }

    if activeToken != nil {
      record(type: "discovery-skipped", detail: "in-flight")
      return #"{"outcome":"skipped","detail":"in-flight"}"#
    }

    let signature = BackgroundDiscoveryPolicy.itemSignature(items)
    var attempt = loadAttempt()
    attempt.inFlightToken = execution.token
    attempt.inFlightStartedAt = startedAt.timeIntervalSince1970
    attempt.inFlightLatitude = sample.latitude
    attempt.inFlightLongitude = sample.longitude
    attempt.inFlightItemSignature = signature
    attempt.lastArrivalKey = arrivalKey(sample)
    saveAttempt(attempt)
    activeToken = execution.token
    record(type: "discovery-started", detail: "items=\(items.count)")

    let transport = await fetchCandidates(
      input: input,
      items: items,
      sample: sample,
      execution: execution
    )
    let outcome = BackgroundDiscoveryPolicy.classifyResponse(
      cancelled: transport.cancelled,
      expired: execution.isBlocked || transport.expired,
      timedOut: transport.timedOut,
      networkError: transport.networkError,
      httpStatus: transport.httpStatus,
      parsedOutcome: transport.parsedOutcome
    )
    guard BackgroundDiscoveryPolicy.shouldApply(outcome) else {
      persistFailure(
        token: execution.token,
        sample: sample,
        signature: signature,
        at: Date()
      )
      record(
        type: "discovery-finished",
        detail: outcome,
        durationSeconds: Date().timeIntervalSince(startedAt),
        storeCount: 0
      )
      return #"{"outcome":"failed","detail":"\#(outcome)"}"#
    }

    let before = BackgroundDiscoveryPolicy.commitPlan(
      expiredOrCancelledBeforeReconcile: execution.isBlocked,
      expiredOrCancelledAfterReconcile: false
    )
    guard before.reconcile else {
      persistFailure(
        token: execution.token,
        sample: sample,
        signature: signature,
        at: startedAt
      )
      record(type: "discovery-finished", detail: "expired-before-reconcile")
      return #"{"outcome":"failed","detail":"expired-before-reconcile"}"#
    }

    if !commitsCurrentInput(signature) {
      return discardInputChange(token: execution.token, sample: sample, signature: signature)
    }

    let currentSnapshot = loadGeofenceSnapshot()
    if shouldDiscard(
      requestStartedAt: startedAt,
      signature: signature,
      sample: sample,
      snapshot: currentSnapshot,
      attempt: loadAttempt()
    ) {
      record(type: "discovery-skipped", detail: "foreground-won")
      return #"{"outcome":"skipped","detail":"foreground-won"}"#
    }

    guard let snapshot = makeSnapshot(
      items: items,
      stores: transport.stores,
      sample: sample,
      previous: currentSnapshot,
      now: Date()
    ) else {
      persistFailure(
        token: execution.token,
        sample: sample,
        signature: signature,
        at: Date()
      )
      record(type: "discovery-finished", detail: "invalid-snapshot")
      return #"{"outcome":"failed","detail":"invalid-snapshot"}"#
    }

    let committed: CommittedDiscovery
    do {
      guard
        BackgroundDiscoveryPolicy.commitPlan(
          expiredOrCancelledBeforeReconcile: execution.isBlocked,
          expiredOrCancelledAfterReconcile: false
        ).reconcile
      else {
        persistFailure(
          token: execution.token,
          sample: sample,
          signature: signature,
          at: startedAt
        )
        record(type: "discovery-finished", detail: "expired-before-reconcile")
        return #"{"outcome":"failed","detail":"expired-before-reconcile"}"#
      }
      committed = try await commitSnapshot(
        snapshot,
        sample: sample,
        signature: signature,
        requestStartedAt: startedAt,
        execution: execution
      )
    } catch BackgroundDiscoveryCommitError.inputChanged {
      return discardInputChange(token: execution.token, sample: sample, signature: signature)
    } catch BackgroundDiscoveryCommitError.discarded {
      record(type: "discovery-skipped", detail: "foreground-won")
      return #"{"outcome":"skipped","detail":"foreground-won"}"#
    } catch {
      persistFailure(
        token: execution.token,
        sample: sample,
        signature: signature,
        at: Date()
      )
      let detail =
        error is BackgroundDiscoveryCommitError
        ? "reconciliation-not-applied"
        : "reconciliation-failed"
      record(
        type: "discovery-finished",
        detail: detail,
        durationSeconds: Date().timeIntervalSince(startedAt)
      )
      return #"{"outcome":"failed","detail":"\#(detail)"}"#
    }

    persistSuccess(
      token: execution.token,
      signature: signature,
      placeSignature: BackgroundDiscoveryPolicy.placeItemsSignature(items),
      generatedAt: committed.generatedAt
    )
    record(
      type: "reconciliation-applied",
      detail: "stores=\(snapshot.stores.count);scheduled=\(committed.report.scheduledPlaceIds.count)",
      storeCount: committed.report.state.snapshot?.stores.count ?? snapshot.stores.count
    )

    let afterReconcile = BackgroundDiscoveryPolicy.commitPlan(
      expiredOrCancelledBeforeReconcile: false,
      expiredOrCancelledAfterReconcile: execution.isBlocked
    )
    guard afterReconcile.observe else {
      record(
        type: "observation-skipped",
        detail: "execution-expired-after-reconcile",
        storeCount: committed.report.scheduledPlaceIds.count
      )
      record(
        type: "discovery-finished",
        detail: "reconciled-observations-skipped",
        durationSeconds: Date().timeIntervalSince(startedAt),
        storeCount: snapshot.stores.count
      )
      return #"{"outcome":"reconciled","detail":"observations-skipped"}"#
    }

    let startedObservations = await startAlreadyNearbyObservations(
      report: committed.report,
      snapshot: committed.report.state.snapshot ?? snapshot,
      sample: sample,
      execution: execution
    )
    if startedObservations > 0 {
      await ThereYouGoSmartArrivalRuntime.shared.syncToPersistedObservations()
    }
    record(
      type: "discovery-finished",
      detail: "observations=\(startedObservations)",
      durationSeconds: Date().timeIntervalSince(startedAt),
      storeCount: snapshot.stores.count
    )
    return #"{"outcome":"reconciled","detail":"observations=\#(startedObservations)"}"#
  }

  private func fetchCandidates(
    input: PersistedBackgroundDiscoveryInput,
    items: [BackgroundDiscoveryPolicy.Item],
    sample: BackgroundDiscoveryVisitSample,
    execution: BackgroundDiscoveryExecution
  ) async -> TransportResult {
    guard
      let url = URL(string: input.apiBaseUrl + "/places/candidates"),
      url.scheme == "http" || url.scheme == "https",
      let body = requestBody(items: items, sample: sample)
    else {
      return TransportResult.network
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = BackgroundDiscoveryPolicy.requestTimeoutSeconds
    request.httpBody = body

    if execution.isBlocked {
      return TransportResult(
        cancelled: false,
        expired: true,
        timedOut: false,
        networkError: false,
        httpStatus: nil,
        parsedOutcome: nil,
        stores: []
      )
    }

    do {
      let (data, http) = try await execution.response(for: request, session: session)
      let parsed =
        http.statusCode == 200
        ? BackgroundDiscoveryPolicy.parseBody(data)
        : nil
      return TransportResult(
        cancelled: false,
        expired: execution.isBlocked,
        timedOut: false,
        networkError: false,
        httpStatus: http.statusCode,
        parsedOutcome: parsed?.outcome,
        stores: parsed?.stores ?? []
      )
    } catch {
      let urlError = error as? URLError
      return TransportResult(
        cancelled: urlError?.code == .cancelled,
        expired: execution.isBlocked,
        timedOut: urlError?.code == .timedOut,
        networkError: urlError?.code != .cancelled && urlError?.code != .timedOut,
        httpStatus: nil,
        parsedOutcome: nil,
        stores: []
      )
    }
  }

  private func commitSnapshot(
    _ snapshot: PersistedCandidateSnapshot,
    sample: BackgroundDiscoveryVisitSample,
    signature: String,
    requestStartedAt: Date,
    execution: BackgroundDiscoveryExecution
  ) async throws -> CommittedDiscovery {
    try ensureCurrentItems(signature)
    guard
      BackgroundDiscoveryPolicy.commitPlan(
        expiredOrCancelledBeforeReconcile: execution.isBlocked,
        expiredOrCancelledAfterReconcile: false
      ).reconcile
    else {
      throw BackgroundDiscoveryCommitError.expired
    }
    do {
      let report = try await ThereYouGoLocationNotificationReconciler.shared.sync(
        snapshot: snapshot
      )
      return CommittedDiscovery(report: report, generatedAt: snapshot.generatedAt)
    } catch is SnapshotFreshnessError {
      try ensureCurrentItems(signature)
      guard
        BackgroundDiscoveryPolicy.commitPlan(
          expiredOrCancelledBeforeReconcile: execution.isBlocked,
          expiredOrCancelledAfterReconcile: false
        ).reconcile
      else {
        throw BackgroundDiscoveryCommitError.expired
      }
      let reloaded = try await ThereYouGoLocationNotificationReconciler.shared.getState()
      if shouldDiscard(
        requestStartedAt: requestStartedAt,
        signature: signature,
        sample: sample,
        snapshot: reloaded.snapshot,
        attempt: loadAttempt()
      ) {
        throw BackgroundDiscoveryCommitError.discarded
      }
      guard
        BackgroundDiscoveryPolicy.commitPlan(
          expiredOrCancelledBeforeReconcile: execution.isBlocked,
          expiredOrCancelledAfterReconcile: false
        ).reconcile,
        let previousDate = reloaded.snapshot.flatMap({
          CandidateSnapshotValidator.iso8601Date($0.generatedAt)
        }),
        let retried = replacingGeneratedAt(
          snapshot,
          generatedAt: BackgroundDiscoveryPolicy.nextGeneratedAt(
            now: Date(),
            previous: previousDate
          )
        )
      else {
        throw BackgroundDiscoveryCommitError.expired
      }
      try ensureCurrentItems(signature)
      do {
        let report = try await ThereYouGoLocationNotificationReconciler.shared.sync(
          snapshot: retried
        )
        return CommittedDiscovery(report: report, generatedAt: retried.generatedAt)
      } catch is SnapshotFreshnessError {
        throw BackgroundDiscoveryCommitError.stale
      }
    }
  }

  private func startAlreadyNearbyObservations(
    report: NativeSyncReport,
    snapshot: PersistedCandidateSnapshot,
    sample: BackgroundDiscoveryVisitSample,
    execution: BackgroundDiscoveryExecution
  ) async -> Int {
    let scheduled = Set(report.scheduledPlaceIds)
    let storesById = Dictionary(
      uniqueKeysWithValues: snapshot.stores.map { ($0.placeId, $0) }
    )
    let candidates = report.state.selectedPlaceIds.compactMap { placeId -> BackgroundDiscoveryPolicy.NearbyStore? in
      guard
        let store = storesById[placeId],
        let request = report.state.requests.first(where: { $0.placeId == placeId })
      else {
        return nil
      }
      return BackgroundDiscoveryPolicy.NearbyStore(
        placeId: placeId,
        latitude: store.location.latitude,
        longitude: store.location.longitude,
        selected: true,
        pending: request.status == .pending && request.isPending,
        newlyScheduled: scheduled.contains(placeId)
      )
    }
    let nearby = BackgroundDiscoveryPolicy.alreadyNearby(
      visitAccuracyMeters: sample.horizontalAccuracy,
      visitLatitude: sample.latitude,
      visitLongitude: sample.longitude,
      stores: candidates
    )
    record(
      type: "already-nearby-evaluated",
      detail: "candidates=\(candidates.count);nearby=\(nearby.count)",
      accuracyMeters: sample.horizontalAccuracy,
      storeCount: nearby.count
    )

    var started = 0
    for placeId in nearby {
      guard
        BackgroundDiscoveryPolicy.commitPlan(
          expiredOrCancelledBeforeReconcile: false,
          expiredOrCancelledAfterReconcile: execution.isBlocked
        ).observe
      else {
        record(type: "observation-skipped", detail: "execution-expired", storeName: storeName(placeId, snapshot))
        break
      }
      guard
        let request = report.state.requests.first(where: {
          $0.placeId == placeId && $0.status == .pending
        })
      else {
        record(type: "observation-skipped", detail: "not-pending", storeName: storeName(placeId, snapshot))
        continue
      }
      let didStart = await ThereYouGoLocationNotificationReconciler.shared.regionEntered(
        installationId: request.installationId,
        at: Date()
      )
      if didStart {
        started += 1
        record(type: "observation-started", detail: request.installationId, storeName: storeName(placeId, snapshot))
      } else {
        record(type: "observation-skipped", detail: "not-started", storeName: storeName(placeId, snapshot))
      }
    }
    return started
  }

  private func makeSnapshot(
    items: [BackgroundDiscoveryPolicy.Item],
    stores: [BackgroundDiscoveryPolicy.DecodedStore],
    sample: BackgroundDiscoveryVisitSample,
    previous: PersistedCandidateSnapshot?,
    now: Date
  ) -> PersistedCandidateSnapshot? {
    let previousDate = previous.flatMap {
      CandidateSnapshotValidator.iso8601Date($0.generatedAt)
    }
    let generatedAt = canonicalTimestamp(
      BackgroundDiscoveryPolicy.nextGeneratedAt(now: now, previous: previousDate)
    )
    guard CandidateSnapshotValidator.iso8601Date(generatedAt) != nil else {
      return nil
    }
    let knownItemIds = Set(items.map(\.id))
    let record = CandidateSnapshotInputRecord()
    record.schemaVersion = GeofenceNotificationConstants.candidateSchemaVersion
    record.generatedAt = generatedAt
    let anchor = CandidateCoordinateInputRecord()
    anchor.latitude = sample.latitude
    anchor.longitude = sample.longitude
    record.discoveryAnchor = anchor
    record.items = items.map { item in
      let record = CandidateSnapshotItemInputRecord()
      record.id = item.id
      record.revision = item.revision
      record.text = item.text
      record.categories = item.categories
      return record
    }
    record.stores = stores.compactMap { store in
      let itemIds = store.itemIds.filter { knownItemIds.contains($0) }
      guard !itemIds.isEmpty else {
        return nil
      }
      let record = CandidateSnapshotStoreInputRecord()
      record.placeId = store.placeId
      record.name = store.name
      let location = CandidateCoordinateInputRecord()
      location.latitude = store.latitude
      location.longitude = store.longitude
      record.location = location
      record.itemIds = itemIds
      return record
    }
    return try? CandidateSnapshotValidator.validate(record)
  }

  private func replacingGeneratedAt(
    _ snapshot: PersistedCandidateSnapshot,
    generatedAt: Date
  ) -> PersistedCandidateSnapshot? {
    let text = canonicalTimestamp(generatedAt)
    guard CandidateSnapshotValidator.iso8601Date(text) != nil else {
      return nil
    }
    return PersistedCandidateSnapshot(
      schemaVersion: snapshot.schemaVersion,
      generatedAt: text,
      discoveryAnchor: snapshot.discoveryAnchor,
      items: snapshot.items,
      stores: snapshot.stores
    )
  }

  private func commitsCurrentInput(_ signature: String) -> Bool {
    BackgroundDiscoveryPolicy.shouldCommitDiscoveredItems(
      requestItemSignature: signature,
      currentItems: policyItems(loadInput())
    )
  }

  private func ensureCurrentItems(_ signature: String) throws {
    if !commitsCurrentInput(signature) {
      throw BackgroundDiscoveryCommitError.inputChanged
    }
  }

  private func discardInputChange(
    token: String,
    sample: BackgroundDiscoveryVisitSample,
    signature: String
  ) -> String {
    if BackgroundDiscoveryPolicy.shouldRecordFailureCooldown(after: "input-changed") {
      persistFailure(
        token: token,
        sample: sample,
        signature: signature,
        at: Date()
      )
    }
    record(type: "discovery-skipped", detail: "input-changed")
    return #"{"outcome":"skipped","detail":"input-changed"}"#
  }

  private func shouldDiscard(
    requestStartedAt: Date,
    signature: String,
    sample: BackgroundDiscoveryVisitSample,
    snapshot: PersistedCandidateSnapshot?,
    attempt: PersistedBackgroundDiscoveryAttempt
  ) -> Bool {
    guard
      let snapshot,
      let generatedAt = CandidateSnapshotValidator.iso8601Date(snapshot.generatedAt)
    else {
      return false
    }
    let persistedSignature =
      attempt.successfulGeneratedAt == snapshot.generatedAt
      ? (attempt.successfulItemSignature ?? "unknown")
      : "unknown"
    return BackgroundDiscoveryPolicy.shouldDiscard(
      requestStartedAt: requestStartedAt,
      requestItemSignature: signature,
      visitLatitude: sample.latitude,
      visitLongitude: sample.longitude,
      persisted: BackgroundDiscoveryPolicy.PersistedSnapshot(
        generatedAt: generatedAt,
        itemSignature: persistedSignature,
        latitude: snapshot.discoveryAnchor.latitude,
        longitude: snapshot.discoveryAnchor.longitude
      )
    )
  }

  private func requestBody(
    items: [BackgroundDiscoveryPolicy.Item],
    sample: BackgroundDiscoveryVisitSample
  ) -> Data? {
    let payload: [String: Any] = [
      "items": items.sorted { $0.id < $1.id }.map { item in
        [
          "id": item.id,
          "revision": item.revision,
          "taxonomyVersion": item.taxonomyVersion,
          "categories": item.categories,
        ] as [String: Any]
      },
      "location": [
        "latitude": sample.latitude,
        "longitude": sample.longitude,
      ],
    ]
    return try? JSONSerialization.data(withJSONObject: payload)
  }

  private func persistFailure(
    token: String,
    sample: BackgroundDiscoveryVisitSample,
    signature: String,
    at date: Date
  ) {
    var attempt = loadAttempt()
    guard attempt.inFlightToken == token else {
      return
    }
    attempt.inFlightToken = nil
    attempt.inFlightStartedAt = nil
    attempt.inFlightLatitude = nil
    attempt.inFlightLongitude = nil
    attempt.inFlightItemSignature = nil
    attempt.lastFailureAt = date.timeIntervalSince1970
    attempt.lastFailureLatitude = sample.latitude
    attempt.lastFailureLongitude = sample.longitude
    attempt.lastFailureItemSignature = signature
    saveAttempt(attempt)
  }

  private func persistSuccess(
    token: String,
    signature: String,
    placeSignature: String,
    generatedAt: String
  ) {
    var attempt = loadAttempt()
    guard attempt.inFlightToken == token || activeToken == token else {
      return
    }
    attempt.inFlightToken = nil
    attempt.inFlightStartedAt = nil
    attempt.inFlightLatitude = nil
    attempt.inFlightLongitude = nil
    attempt.inFlightItemSignature = nil
    attempt.lastFailureAt = nil
    attempt.lastFailureLatitude = nil
    attempt.lastFailureLongitude = nil
    attempt.lastFailureItemSignature = nil
    attempt.successfulItemSignature = signature
    attempt.successfulPlaceItemsSignature = placeSignature
    attempt.successfulGeneratedAt = generatedAt
    saveAttempt(attempt)
  }

  private func decisionAnchor(
    snapshot: PersistedCandidateSnapshot?,
    attempt: PersistedBackgroundDiscoveryAttempt
  ) -> BackgroundDiscoveryPolicy.Anchor? {
    guard
      let snapshot,
      attempt.successfulGeneratedAt == snapshot.generatedAt,
      let signature = attempt.successfulItemSignature
    else {
      return nil
    }
    return BackgroundDiscoveryPolicy.Anchor(
      itemSignature: signature,
      latitude: snapshot.discoveryAnchor.latitude,
      longitude: snapshot.discoveryAnchor.longitude
    )
  }

  private func policyItems(
    _ input: PersistedBackgroundDiscoveryInput
  ) -> [BackgroundDiscoveryPolicy.Item] {
    input.items.map {
      BackgroundDiscoveryPolicy.Item(
        id: $0.id,
        revision: $0.revision,
        text: $0.text,
        taxonomyVersion: $0.taxonomyVersion,
        categories: $0.categories
      )
    }
  }

  private func policyAttempt(
    _ attempt: PersistedBackgroundDiscoveryAttempt
  ) -> BackgroundDiscoveryPolicy.Attempt {
    BackgroundDiscoveryPolicy.Attempt(
      inFlightStartedAt: attempt.inFlightStartedAt.map {
        Date(timeIntervalSince1970: $0)
      },
      inFlightLatitude: attempt.inFlightLatitude,
      inFlightLongitude: attempt.inFlightLongitude,
      inFlightItemSignature: attempt.inFlightItemSignature,
      lastArrivalKey: attempt.lastArrivalKey,
      lastFailureAt: attempt.lastFailureAt.map {
        Date(timeIntervalSince1970: $0)
      },
      lastFailureLatitude: attempt.lastFailureLatitude,
      lastFailureLongitude: attempt.lastFailureLongitude,
      lastFailureItemSignature: attempt.lastFailureItemSignature
    )
  }

  private func loadInput() -> PersistedBackgroundDiscoveryInput {
    guard
      let data = UserDefaults.standard.data(forKey: BackgroundDiscoveryStorage.inputKey),
      let input = try? JSONDecoder().decode(
        PersistedBackgroundDiscoveryInput.self,
        from: data
      ),
      input.schemaVersion == BackgroundDiscoveryPolicy.schemaVersion
    else {
      return .empty
    }
    return input
  }

  private func saveInput(_ input: PersistedBackgroundDiscoveryInput) {
    guard let data = try? encoder.encode(input) else {
      return
    }
    UserDefaults.standard.set(data, forKey: BackgroundDiscoveryStorage.inputKey)
  }

  private func loadAttempt() -> PersistedBackgroundDiscoveryAttempt {
    optionalAttempt() ?? .empty
  }

  private func optionalAttempt() -> PersistedBackgroundDiscoveryAttempt? {
    guard
      let data = UserDefaults.standard.data(forKey: BackgroundDiscoveryStorage.attemptKey),
      let attempt = try? JSONDecoder().decode(
        PersistedBackgroundDiscoveryAttempt.self,
        from: data
      ),
      attempt.schemaVersion == BackgroundDiscoveryPolicy.schemaVersion
    else {
      return nil
    }
    return attempt
  }

  private func saveAttempt(_ attempt: PersistedBackgroundDiscoveryAttempt) {
    guard let data = try? encoder.encode(attempt) else {
      return
    }
    UserDefaults.standard.set(data, forKey: BackgroundDiscoveryStorage.attemptKey)
  }

  private func loadGeofenceSnapshot() -> PersistedCandidateSnapshot? {
    guard
      let data = UserDefaults.standard.data(
        forKey: GeofenceNotificationConstants.userDefaultsKey
      ),
      let state = try? JSONDecoder().decode(PersistedGeofenceState.self, from: data)
    else {
      return nil
    }
    return state.snapshot
  }

  private func arrivalKey(_ sample: BackgroundDiscoveryVisitSample) -> String {
    let arrival = sample.arrivalDate ?? Date.distantPast
    let latitude = (sample.latitude * 100_000).rounded() / 100_000
    let longitude = (sample.longitude * 100_000).rounded() / 100_000
    return "\(canonicalTimestamp(arrival))|\(latitude)|\(longitude)"
  }

  private func canonicalTimestamp(_ date: Date) -> String {
    let milliseconds = (date.timeIntervalSince1970 * 1_000).rounded()
    let truncated = Date(timeIntervalSince1970: milliseconds / 1_000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    let text = formatter.string(from: truncated)
    if CandidateSnapshotValidator.iso8601Date(text) != nil {
      return text
    }
    let fallback = DateFormatter()
    fallback.locale = Locale(identifier: "en_US_POSIX")
    fallback.timeZone = TimeZone(secondsFromGMT: 0)
    fallback.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    return fallback.string(from: truncated)
  }

  private func applicationStateName() -> String {
    switch UIApplication.shared.applicationState {
    case .active:
      return "active"
    case .inactive:
      return "inactive"
    case .background:
      return "background"
    @unknown default:
      return "background"
    }
  }

  private func visitDetail(_ sample: BackgroundDiscoveryVisitSample) -> String {
    let kind: String
    if sample.arrivalDate != nil && sample.departureDate == nil {
      kind = "arrival"
    } else if sample.arrivalDate != nil && sample.departureDate != nil {
      kind = "departure"
    } else if sample.departureDate != nil {
      kind = "departure"
    } else {
      kind = "unknown"
    }
    return "kind=\(kind);coordinateValid=\(sample.coordinateValid)"
  }

  private func storeName(
    _ placeId: String,
    _ snapshot: PersistedCandidateSnapshot
  ) -> String? {
    snapshot.stores.first { $0.placeId == placeId }?.name
  }

  private func record(
    type: String,
    detail: String? = nil,
    durationSeconds: Double? = nil,
    accuracyMeters: Double? = nil,
    distanceFromAnchorMeters: Double? = nil,
    storeCount: Int? = nil,
    storeName: String? = nil
  ) {
    #if DEBUG
    BackgroundDiscoveryDevelopmentEventLog.record(
      type: type,
      detail: detail,
      durationSeconds: durationSeconds,
      accuracyMeters: accuracyMeters,
      distanceFromAnchorMeters: distanceFromAnchorMeters,
      storeCount: storeCount,
      storeName: storeName
    )
    #endif
  }

  private func escapeJSON(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
  }
}

private struct TransportResult {
  var cancelled: Bool
  var expired: Bool
  var timedOut: Bool
  var networkError: Bool
  var httpStatus: Int?
  var parsedOutcome: String?
  var stores: [BackgroundDiscoveryPolicy.DecodedStore]

  static let network = TransportResult(
    cancelled: false,
    expired: false,
    timedOut: false,
    networkError: true,
    httpStatus: nil,
    parsedOutcome: nil,
    stores: []
  )
}

private struct CommittedDiscovery {
  var report: NativeSyncReport
  var generatedAt: String
}

private enum BackgroundDiscoveryCommitError: Error {
  case expired
  case discarded
  case inputChanged
  case stale
}
