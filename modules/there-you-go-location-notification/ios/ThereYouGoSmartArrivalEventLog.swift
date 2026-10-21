import CoreLocation
import ExpoModulesCore
import Foundation

// Debug-only history of production Smart Arrival decisions. Release builds do
// not collect or persist these events. Recording observes transitions that
// have already run and does not choose arrivals or notifications.

struct SmartArrivalDevelopmentEventRecord: Record {
  @Field var sequence: Int = 0
  @Field var recordedAt: String = ""
  @Field var type: String = ""
  @Field var placeId: String? = nil
  @Field var storeName: String? = nil
  @Field var detail: String? = nil
}

struct SmartArrivalDevelopmentEventHistoryRecord: Record {
  @Field var droppedEventCount: Int = 0
  @Field var events: [SmartArrivalDevelopmentEventRecord] = []
}

func smartArrivalDevelopmentEventHistory() -> SmartArrivalDevelopmentEventHistoryRecord {
  #if DEBUG
  return SmartArrivalDevelopmentEventLog.historyRecord()
  #else
  return SmartArrivalDevelopmentEventHistoryRecord()
  #endif
}

func clearSmartArrivalDevelopmentEventHistory() -> SmartArrivalDevelopmentEventHistoryRecord {
  #if DEBUG
  SmartArrivalDevelopmentEventLog.clear()
  #endif
  return SmartArrivalDevelopmentEventHistoryRecord()
}

#if DEBUG

private struct SmartArrivalDevelopmentEvent: Codable, Equatable {
  var sequence: Int
  let recordedAt: String
  let type: String
  let placeId: String?
  let storeName: String?
  let detail: String?

  private enum CodingKeys: String, CodingKey {
    case sequence
    case recordedAt
    case type
    case placeId
    case storeName
    case detail
  }

  init(
    sequence: Int,
    recordedAt: String,
    type: String,
    placeId: String?,
    storeName: String?,
    detail: String?
  ) {
    self.sequence = sequence
    self.recordedAt = recordedAt
    self.type = type
    self.placeId = placeId
    self.storeName = storeName
    self.detail = detail
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    sequence = try container.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
    recordedAt = try container.decode(String.self, forKey: .recordedAt)
    type = try container.decode(String.self, forKey: .type)
    placeId = try container.decodeIfPresent(String.self, forKey: .placeId)
    storeName = try container.decodeIfPresent(String.self, forKey: .storeName)
    detail = try container.decodeIfPresent(String.self, forKey: .detail)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(sequence, forKey: .sequence)
    try container.encode(recordedAt, forKey: .recordedAt)
    try container.encode(type, forKey: .type)
    try container.encodeIfPresent(placeId, forKey: .placeId)
    try container.encodeIfPresent(storeName, forKey: .storeName)
    try container.encodeIfPresent(detail, forKey: .detail)
  }
}

private struct SmartArrivalDevelopmentEventEnvelope: Codable {
  var droppedEventCount: Int
  var nextSequence: Int
  var events: [SmartArrivalDevelopmentEvent]

  private enum CodingKeys: String, CodingKey {
    case droppedEventCount
    case nextSequence
    case events
  }

  init(
    droppedEventCount: Int,
    nextSequence: Int,
    events: [SmartArrivalDevelopmentEvent]
  ) {
    self.droppedEventCount = droppedEventCount
    self.nextSequence = nextSequence
    self.events = events
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    var decodedEvents =
      try container.decodeIfPresent(
        [SmartArrivalDevelopmentEvent].self,
        forKey: .events
      ) ?? []
    droppedEventCount = max(
      0,
      try container.decodeIfPresent(Int.self, forKey: .droppedEventCount) ?? 0
    )
    let storedNextSequence = try container.decodeIfPresent(
      Int.self,
      forKey: .nextSequence
    )
    let hadSequences = decodedEvents.contains { $0.sequence > 0 }
    if !hadSequences {
      for index in decodedEvents.indices {
        decodedEvents[index].sequence = index + 1
      }
    }
    events = decodedEvents
    let maxSequence = decodedEvents.map(\.sequence).max() ?? 0
    nextSequence = max(storedNextSequence ?? 0, maxSequence + 1)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(droppedEventCount, forKey: .droppedEventCount)
    try container.encode(nextSequence, forKey: .nextSequence)
    try container.encode(events, forKey: .events)
  }
}

private enum SmartArrivalDevelopmentEventType {
  static let regionEntry = "region-entry"
  static let walkingQualified = "walking-qualified"
  static let automotiveEvidence = "automotive-evidence"
  static let evidenceRejected = "evidence-rejected"
  static let observationEnded = "observation-ended"
  static let notificationAttempted = "notification-attempted"
  static let notificationSucceeded = "notification-succeeded"
  static let notificationFailed = "notification-failed"
}

private enum SmartArrivalDevelopmentEventLogConstants {
  // Keep this equal to SMART_ARRIVAL_DEVELOPMENT_EVENT_HISTORY_LIMIT.
  static let maximumEvents = 100
  static let userDefaultsKey =
    "there-you-go.smart-arrival.development-events.v1"
}

enum SmartArrivalDevelopmentEventLog {
  private static let store = SmartArrivalDevelopmentEventStore()

  static func historyRecord() -> SmartArrivalDevelopmentEventHistoryRecord {
    let snapshot = store.read()
    let record = SmartArrivalDevelopmentEventHistoryRecord()
    record.droppedEventCount = snapshot.droppedEventCount
    record.events = snapshot.events.map(makeEventRecord)
    return record
  }

  static func clear() {
    store.clear()
  }

  // Groups the events recorded by `body` into one history write. Nested
  // groups join the outer group. The caller decides whether that write happens.
  static func beginBatch() {
    store.beginBatch()
  }

  static func endBatch(commit: Bool) {
    store.endBatch(commit: commit)
  }

  static func batch(_ body: () -> Void) {
    beginBatch()
    body()
    endBatch(commit: true)
  }

  static func recordRuntimeIneligible(installationId: String, at date: Date) {
    recordRegionEntry(
      placeId: nil,
      storeName: nil,
      at: date,
      detail: "runtime-ineligible installation=\(installationId)"
    )
  }

  static func recordRegionEntry(
    placeId: String?,
    storeName: String?,
    at date: Date,
    detail: String
  ) {
    record(
      type: SmartArrivalDevelopmentEventType.regionEntry,
      at: date,
      placeId: placeId,
      storeName: storeName,
      detail: detail
    )
  }

  static func recordRegionEntryResult(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    placeId: String,
    installationId: String,
    at date: Date
  ) {
    batch {
      recordRecoverEnds(before: before, at: date)
      let recovered = SmartArrivalStateTransitions.recover(before, at: date)
      let recoveredIds = Set(recovered.observations.map(\.identifier))
      let added = after.observations.filter {
        !recoveredIds.contains($0.identifier)
      }
      let name = storeName(placeId, after.snapshot ?? before.snapshot)
      if added.isEmpty {
        recordRegionEntry(
          placeId: placeId,
          storeName: name,
          at: date,
          detail: "ignored installation=\(installationId)"
        )
        return
      }
      for observation in added {
        recordRegionEntry(
          placeId: placeId,
          storeName: name,
          at: date,
          detail: "started observation=\(observation.identifier)"
        )
      }
    }
  }

  static func recordMotionTransition(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    evidence: SmartArrivalMotionEvidence,
    latestLocation: SmartArrivalLocationEvidence?
  ) {
    batch {
      // Replay the pure motion transition without location so accepted evidence
      // stays distinct from the location decision that followed it.
      recordRecoverEnds(before: before, at: evidence.receivedAt)
      let motionOnly = SmartArrivalStateTransitions.motionObserved(
        evidence,
        latestLocation: nil,
        in: before
      )
      recordAcceptedMotion(before: before, after: motionOnly, evidence: evidence)
      recordRejectedMotion(
        observations: motionOnly.observations,
        evidence: evidence,
        snapshot: motionOnly.snapshot ?? before.snapshot
      )
      let baseline = SmartArrivalStateTransitions.recover(
        motionOnly,
        at: evidence.receivedAt
      )
      recordLocationEnds(
        before: baseline,
        after: after,
        at: evidence.receivedAt
      )
      if let latestLocation {
        recordRejectedLocation(
          latestLocation,
          observations: after.observations,
          at: evidence.receivedAt,
          snapshot: after.snapshot ?? before.snapshot
        )
      }
    }
  }

  static func recordLocationTransition(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    evidence: SmartArrivalLocationEvidence,
    at date: Date
  ) {
    batch {
      recordRecoverEnds(before: before, at: date)
      let baseline = SmartArrivalStateTransitions.recover(before, at: date)
      recordLocationEnds(before: baseline, after: after, at: date)
      recordRejectedLocation(
        evidence,
        observations: after.observations,
        at: date,
        snapshot: after.snapshot ?? before.snapshot
      )
    }
  }

  static func recordRecoverEnds(
    before: PersistedGeofenceState,
    at date: Date
  ) {
    batch {
      let invalidated = SmartArrivalStateTransitions.invalidate(before)
      recordObservationEnds(
        removedObservations(before.observations, invalidated.observations),
        at: date,
        snapshot: before.snapshot,
        reason: "invalidation"
      )
      let recovered = SmartArrivalStateTransitions.recover(before, at: date)
      let timedOut = removedObservations(
        invalidated.observations,
        recovered.observations
      )
      for observation in timedOut {
        if let parsedDeadline = CandidateSnapshotValidator.iso8601Date(
          observation.deadline
        ), date >= parsedDeadline {
          recordObservationEnds(
            [observation],
            at: date,
            snapshot: before.snapshot,
            reason: "timeout",
            extra: "deadline=\(observation.deadline)"
          )
        } else {
          recordObservationEnds(
            [observation],
            at: date,
            snapshot: before.snapshot,
            reason: "invalidation"
          )
        }
      }
    }
  }

  static func recordPermissionLoss(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    at date: Date,
    missingRequirements: [String]
  ) {
    batch {
      let extra = missingRequirements.isEmpty
        ? nil
        : "missing=\(missingRequirements.joined(separator: ","))"
      recordObservationEnds(
        removedObservations(before.observations, after.observations),
        at: date,
        snapshot: after.snapshot ?? before.snapshot,
        reason: "permission-loss",
        extra: extra
      )
    }
  }

  static func recordDeliveryRecovery(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    at date: Date,
    pendingNotificationIds: Set<String>,
    deliveredNotificationIds: Set<String>
  ) {
    batch {
      recordRecoverEnds(before: before, at: date)
      let recovered = SmartArrivalStateTransitions.recover(before, at: date)
      recordDeliveredObservations(before: recovered, after: after, at: date)
      recordRecoveredNotificationOutcomes(
        before: recovered,
        after: after,
        pendingNotificationIds: pendingNotificationIds,
        deliveredNotificationIds: deliveredNotificationIds
      )
    }
  }

  static func recordDeliveredObservations(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    at date: Date
  ) {
    batch {
      recordObservationEnds(
        removedObservations(before.observations, after.observations),
        at: date,
        snapshot: after.snapshot ?? before.snapshot,
        reason: "delivered"
      )
    }
  }

  static func recordPersistenceInvalidation(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState
  ) {
    batch {
      recordObservationEnds(
        removedObservations(before.observations, after.observations),
        at: Date(),
        snapshot: after.snapshot ?? before.snapshot,
        reason: "invalidation"
      )
    }
  }

  static func recordNotificationAttempted(
    intent: PersistedSmartArrivalDeliveryIntent,
    snapshot: PersistedCandidateSnapshot?
  ) {
    recordNotification(
      type: SmartArrivalDevelopmentEventType.notificationAttempted,
      intent: intent,
      snapshot: snapshot,
      code: nil
    )
  }

  static func recordNotificationSucceeded(
    intent: PersistedSmartArrivalDeliveryIntent,
    snapshot: PersistedCandidateSnapshot?,
    code: String? = nil
  ) {
    recordNotification(
      type: SmartArrivalDevelopmentEventType.notificationSucceeded,
      intent: intent,
      snapshot: snapshot,
      code: code
    )
  }

  static func recordNotificationFailed(
    intent: PersistedSmartArrivalDeliveryIntent,
    snapshot: PersistedCandidateSnapshot?,
    code: String
  ) {
    recordNotification(
      type: SmartArrivalDevelopmentEventType.notificationFailed,
      intent: intent,
      snapshot: snapshot,
      code: code
    )
  }

  private static func recordAcceptedMotion(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    evidence: SmartArrivalMotionEvidence
  ) {
    var previousById: [String: PersistedSmartArrivalObservation] = [:]
    for observation in before.observations {
      if previousById[observation.identifier] == nil {
        previousById[observation.identifier] = observation
      }
    }
    let snapshot = after.snapshot ?? before.snapshot
    let source = motionSource(evidence.source)
    for observation in after.observations {
      guard let previous = previousById[observation.identifier] else {
        continue
      }
      if previous.walkingEvidenceStartedAt == nil,
        let acceptedAt = observation.walkingEvidenceStartedAt
      {
        record(
          type: SmartArrivalDevelopmentEventType.walkingQualified,
          at: evidence.receivedAt,
          placeId: observation.placeId,
          storeName: storeName(observation.placeId, snapshot),
          detail:
            "activityStartedAt=\(acceptedAt) source=\(source) observation=\(observation.identifier)"
        )
      }
      if previous.automotiveEvidenceStartedAt == nil,
        let acceptedAt = observation.automotiveEvidenceStartedAt
      {
        record(
          type: SmartArrivalDevelopmentEventType.automotiveEvidence,
          at: evidence.receivedAt,
          placeId: observation.placeId,
          storeName: storeName(observation.placeId, snapshot),
          detail:
            "activityStartedAt=\(acceptedAt) source=\(source) observation=\(observation.identifier)"
        )
      }
    }
  }

  // These checks mirror the production motion guards so the history can say
  // why a sample did not qualify. They do not decide qualification.
  private static func recordRejectedMotion(
    observations: [PersistedSmartArrivalObservation],
    evidence: SmartArrivalMotionEvidence,
    snapshot: PersistedCandidateSnapshot?
  ) {
    let eligibleSource =
      evidence.source == .live || evidence.source == .historicalQuery
    let activityIsFuture = evidence.activityStartedAt > evidence.receivedAt
    for observation in observations {
      guard
        let startedAt = CandidateSnapshotValidator.iso8601Date(
          observation.startedAt
        ),
        let deadline = CandidateSnapshotValidator.iso8601Date(
          observation.deadline
        ),
        evidence.receivedAt >= startedAt,
        evidence.receivedAt < deadline
      else {
        continue
      }

      if evidence.automotive && !evidence.walking &&
        observation.automotiveEvidenceStartedAt == nil &&
        eligibleSource &&
        evidence.confidence == .high &&
        !activityIsFuture &&
        evidence.activityStartedAt < startedAt
      {
        recordRejected(
          "automotive-before-window",
          observation: observation,
          snapshot: snapshot,
          at: evidence.receivedAt
        )
      }

      guard evidence.walking && !evidence.automotive else {
        continue
      }
      guard observation.walkingEvidenceStartedAt == nil else {
        continue
      }
      if evidence.confidence != .high {
        let level = evidence.confidence == .low ? "low" : "medium"
        recordRejected(
          "walking-confidence-\(level)",
          observation: observation,
          snapshot: snapshot,
          at: evidence.receivedAt
        )
        continue
      }
      if activityIsFuture {
        recordRejected(
          "walking-future",
          observation: observation,
          snapshot: snapshot,
          at: evidence.receivedAt
        )
        continue
      }
      guard eligibleSource else {
        continue
      }
      let startedDuringObservation =
        evidence.activityStartedAt >= startedAt &&
        evidence.activityStartedAt < deadline
      let liveDuringObservation =
        evidence.source == .live &&
        evidence.receivedAt >= startedAt &&
        evidence.receivedAt < deadline
      if startedDuringObservation || liveDuringObservation {
        continue
      }
      if evidence.activityStartedAt < startedAt && evidence.source != .live {
        recordRejected(
          "walking-before-window",
          observation: observation,
          snapshot: snapshot,
          at: evidence.receivedAt
        )
      } else if evidence.activityStartedAt >= deadline {
        recordRejected(
          "walking-outside-window",
          observation: observation,
          snapshot: snapshot,
          at: evidence.receivedAt
        )
      }
    }
  }

  // Freshness and accuracy are the two halves of the production fresh-fix
  // guard. A fix that passes both is not given a rejection summary.
  private static func recordRejectedLocation(
    _ evidence: SmartArrivalLocationEvidence,
    observations: [PersistedSmartArrivalObservation],
    at date: Date,
    snapshot: PersistedCandidateSnapshot?
  ) {
    guard !observations.isEmpty else {
      return
    }
    let age = date.timeIntervalSince(evidence.timestamp)
    let fresh =
      age >= 0 &&
      age <= SmartArrivalConstants.freshLocationMaximumAgeSeconds
    let accurate =
      CLLocationCoordinate2DIsValid(
        CLLocationCoordinate2D(
          latitude: evidence.coordinate.latitude,
          longitude: evidence.coordinate.longitude
        )
      ) &&
      evidence.horizontalAccuracyMeters.isFinite &&
      evidence.horizontalAccuracyMeters >= 0 &&
      evidence.horizontalAccuracyMeters <=
        SmartArrivalConstants.maximumHorizontalAccuracyMeters
    guard !fresh || !accurate else {
      return
    }
    for observation in observations {
      if !fresh {
        recordRejected(
          "location-stale",
          observation: observation,
          snapshot: snapshot,
          at: date
        )
      }
      if !accurate {
        recordRejected(
          "location-inaccurate",
          observation: observation,
          snapshot: snapshot,
          at: date
        )
      }
    }
  }

  private static func recordRejected(
    _ reason: String,
    observation: PersistedSmartArrivalObservation,
    snapshot: PersistedCandidateSnapshot?,
    at date: Date
  ) {
    record(
      type: SmartArrivalDevelopmentEventType.evidenceRejected,
      at: date,
      placeId: observation.placeId,
      storeName: storeName(observation.placeId, snapshot),
      detail: "\(reason) observation=\(observation.identifier)"
    )
  }

  private static func recordRecoveredNotificationOutcomes(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    pendingNotificationIds: Set<String>,
    deliveredNotificationIds: Set<String>
  ) {
    let remaining = Set(after.deliveryIntents.map(\.notificationId))
    let snapshot = after.snapshot ?? before.snapshot
    for intent in before.deliveryIntents
    where !remaining.contains(intent.notificationId) {
      let delivered = deliveredNotificationIds.contains(intent.notificationId)
      let pending = pendingNotificationIds.contains(intent.notificationId)
      let code: String
      if delivered {
        code = "recovered-delivered"
      } else if pending {
        code = "recovered-pending"
      } else {
        continue
      }
      recordNotificationSucceeded(
        intent: intent,
        snapshot: snapshot,
        code: code
      )
    }
  }

  private static func recordLocationEnds(
    before: PersistedGeofenceState,
    after: PersistedGeofenceState,
    at date: Date
  ) {
    let addedIntentIds = Set(
      after.deliveryIntents.map(\.observationIdentifier)
    ).subtracting(before.deliveryIntents.map(\.observationIdentifier))
    let snapshot = after.snapshot ?? before.snapshot
    let knownPlaceIds = Set(snapshot?.stores.map(\.placeId) ?? [])
    for observation in removedObservations(
      before.observations,
      after.observations
    ) {
      let reason: String
      if addedIntentIds.contains(observation.identifier) {
        reason = "qualified"
      } else if observation.automotiveEvidenceStartedAt != nil,
        knownPlaceIds.contains(observation.placeId)
      {
        reason = "drive-away"
      } else {
        reason = "invalidation"
      }
      recordObservationEnds(
        [observation],
        at: date,
        snapshot: snapshot,
        reason: reason
      )
    }
  }

  private static func recordNotification(
    type: String,
    intent: PersistedSmartArrivalDeliveryIntent,
    snapshot: PersistedCandidateSnapshot?,
    code: String?
  ) {
    let observation = "observation=\(intent.observationIdentifier)"
    let detail = code.map { "\($0) \(observation)" } ?? observation
    record(
      type: type,
      at: Date(),
      placeId: intent.placeId,
      storeName: storeName(intent.placeId, snapshot),
      detail: detail
    )
  }

  private static func recordObservationEnds(
    _ observations: [PersistedSmartArrivalObservation],
    at date: Date,
    snapshot: PersistedCandidateSnapshot?,
    reason: String,
    extra: String? = nil
  ) {
    for observation in observations {
      var detail = "\(reason) observation=\(observation.identifier)"
      if let extra, !extra.isEmpty {
        detail += " \(extra)"
      }
      record(
        type: SmartArrivalDevelopmentEventType.observationEnded,
        at: date,
        placeId: observation.placeId,
        storeName: storeName(observation.placeId, snapshot),
        detail: detail
      )
    }
  }

  private static func record(
    type: String,
    at date: Date,
    placeId: String?,
    storeName: String?,
    detail: String?
  ) {
    store.append(
      SmartArrivalDevelopmentEvent(
        sequence: 0,
        recordedAt: timestamp(date),
        type: type,
        placeId: placeId,
        storeName: storeName,
        detail: detail
      )
    )
  }

  private static func removedObservations(
    _ before: [PersistedSmartArrivalObservation],
    _ after: [PersistedSmartArrivalObservation]
  ) -> [PersistedSmartArrivalObservation] {
    let remaining = Set(after.map(\.identifier))
    return before.filter { !remaining.contains($0.identifier) }
  }

  private static func storeName(
    _ placeId: String,
    _ snapshot: PersistedCandidateSnapshot?
  ) -> String? {
    snapshot?.stores.first { $0.placeId == placeId }?.name
  }

  private static func motionSource(_ source: SmartArrivalMotionSource) -> String {
    switch source {
    case .live:
      return "live"
    case .historicalQuery:
      return "historical-query"
    case .authorizationPrompt:
      return "authorization-prompt"
    }
  }

  private static func timestamp(_ date: Date) -> String {
    store.format(date)
  }

  private static func makeEventRecord(
    _ event: SmartArrivalDevelopmentEvent
  ) -> SmartArrivalDevelopmentEventRecord {
    let record = SmartArrivalDevelopmentEventRecord()
    record.sequence = event.sequence
    record.recordedAt = event.recordedAt
    record.type = event.type
    record.placeId = event.placeId
    record.storeName = event.storeName
    record.detail = event.detail
    return record
  }
}

private struct SmartArrivalDevelopmentEventSnapshot {
  var droppedEventCount: Int
  var events: [SmartArrivalDevelopmentEvent]
}

private final class SmartArrivalDevelopmentEventStore: @unchecked Sendable {
  private let lock = NSLock()
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let timestampFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter
  }()
  private var didLoad = false
  private var cachedEvents: [SmartArrivalDevelopmentEvent] = []
  private var droppedEventCount = 0
  private var nextSequence = 1
  private var batchDepth = 0
  private var pending: [SmartArrivalDevelopmentEvent] = []

  func format(_ date: Date) -> String {
    lock.lock()
    defer { lock.unlock() }
    return timestampFormatter.string(from: date)
  }

  func read() -> SmartArrivalDevelopmentEventSnapshot {
    lock.lock()
    defer { lock.unlock() }
    loadIfNeededUnlocked()
    return SmartArrivalDevelopmentEventSnapshot(
      droppedEventCount: droppedEventCount,
      events: cachedEvents
    )
  }

  func beginBatch() {
    lock.lock()
    batchDepth += 1
    lock.unlock()
  }

  func endBatch(commit: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard batchDepth > 0 else {
      return
    }
    batchDepth -= 1
    if batchDepth > 0 {
      if !commit {
        pending.removeAll(keepingCapacity: true)
      }
      return
    }
    let queued = pending
    pending.removeAll(keepingCapacity: true)
    if commit {
      commitUnlocked(queued)
    }
  }

  func append(_ event: SmartArrivalDevelopmentEvent) {
    lock.lock()
    defer { lock.unlock() }
    if batchDepth > 0 {
      pending.append(event)
      return
    }
    commitUnlocked([event])
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    didLoad = true
    cachedEvents = []
    droppedEventCount = 0
    nextSequence = 1
    pending.removeAll(keepingCapacity: true)
    UserDefaults.standard.removeObject(
      forKey: SmartArrivalDevelopmentEventLogConstants.userDefaultsKey
    )
  }

  private func loadIfNeededUnlocked() {
    guard !didLoad else {
      return
    }
    didLoad = true
    guard
      let data = UserDefaults.standard.data(
        forKey: SmartArrivalDevelopmentEventLogConstants.userDefaultsKey
      ),
      let envelope = try? decoder.decode(
        SmartArrivalDevelopmentEventEnvelope.self,
        from: data
      )
    else {
      return
    }
    cachedEvents = envelope.events
    droppedEventCount = envelope.droppedEventCount
    nextSequence = max(1, envelope.nextSequence)
  }

  private func commitUnlocked(_ incoming: [SmartArrivalDevelopmentEvent]) {
    loadIfNeededUnlocked()
    var events = cachedEvents
    var dropped = droppedEventCount
    var sequence = nextSequence
    var changed = false
    for event in incoming {
      guard shouldKeep(event, history: events) else {
        continue
      }
      var stored = event
      stored.sequence = sequence
      sequence += 1
      events.append(stored)
      changed = true
    }
    guard changed else {
      return
    }
    let limit = SmartArrivalDevelopmentEventLogConstants.maximumEvents
    let overflow = events.count - limit
    if overflow > 0 {
      dropped += overflow
      events.removeFirst(overflow)
    }
    guard
      saveUnlocked(
        events: events,
        droppedEventCount: dropped,
        nextSequence: sequence
      )
    else {
      return
    }
    cachedEvents = events
    droppedEventCount = dropped
    nextSequence = sequence
  }

  private func saveUnlocked(
    events: [SmartArrivalDevelopmentEvent],
    droppedEventCount: Int,
    nextSequence: Int
  ) -> Bool {
    guard
      let data = try? encoder.encode(
        SmartArrivalDevelopmentEventEnvelope(
          droppedEventCount: droppedEventCount,
          nextSequence: nextSequence,
          events: events
        )
      )
    else {
      return false
    }
    UserDefaults.standard.set(
      data,
      forKey: SmartArrivalDevelopmentEventLogConstants.userDefaultsKey
    )
    return true
  }

  private func shouldKeep(
    _ event: SmartArrivalDevelopmentEvent,
    history: [SmartArrivalDevelopmentEvent]
  ) -> Bool {
    if isNotification(event.type) {
      return true
    }
    if isStartedRegionEntry(event) {
      return true
    }
    guard
      let previousIndex = history.lastIndex(where: { sameIdentity($0, event) })
    else {
      return true
    }
    if event.type == SmartArrivalDevelopmentEventType.regionEntry {
      if hasLaterBoundary(history, after: previousIndex) {
        return true
      }
      // Repeated entry callbacks during one visit collapse. The same callback
      // after the observation window is a separate attempt.
      guard
        let previousAt = timestampFormatter.date(
          from: history[previousIndex].recordedAt
        ),
        let eventAt = timestampFormatter.date(from: event.recordedAt)
      else {
        return false
      }
      return eventAt.timeIntervalSince(previousAt) >=
        SmartArrivalConstants.observationDurationSeconds
    }
    // Remaining events identify one observation outcome. A later observation
    // has a different detail, so it is not treated as this repeat.
    return false
  }

  private func hasLaterBoundary(
    _ events: [SmartArrivalDevelopmentEvent],
    after index: Int
  ) -> Bool {
    var cursor = index + 1
    while cursor < events.count {
      if isDedupBoundary(events[cursor]) {
        return true
      }
      cursor += 1
    }
    return false
  }

  private func isDedupBoundary(_ event: SmartArrivalDevelopmentEvent) -> Bool {
    switch event.type {
    case SmartArrivalDevelopmentEventType.observationEnded,
      SmartArrivalDevelopmentEventType.walkingQualified,
      SmartArrivalDevelopmentEventType.automotiveEvidence,
      SmartArrivalDevelopmentEventType.evidenceRejected,
      SmartArrivalDevelopmentEventType.notificationAttempted,
      SmartArrivalDevelopmentEventType.notificationSucceeded,
      SmartArrivalDevelopmentEventType.notificationFailed:
      return true
    case SmartArrivalDevelopmentEventType.regionEntry:
      return isStartedRegionEntry(event)
    default:
      return false
    }
  }

  private func isStartedRegionEntry(
    _ event: SmartArrivalDevelopmentEvent
  ) -> Bool {
    event.type == SmartArrivalDevelopmentEventType.regionEntry &&
      event.detail?.hasPrefix("started ") == true
  }

  private func isNotification(_ type: String) -> Bool {
    type == SmartArrivalDevelopmentEventType.notificationAttempted ||
      type == SmartArrivalDevelopmentEventType.notificationSucceeded ||
      type == SmartArrivalDevelopmentEventType.notificationFailed
  }

  private func sameIdentity(
    _ existing: SmartArrivalDevelopmentEvent,
    _ event: SmartArrivalDevelopmentEvent
  ) -> Bool {
    existing.type == event.type &&
      existing.placeId == event.placeId &&
      existing.detail == event.detail
  }
}

#endif
