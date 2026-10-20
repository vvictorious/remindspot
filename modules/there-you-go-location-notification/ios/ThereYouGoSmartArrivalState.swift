import CoreLocation
import Foundation

enum SmartArrivalConstants {
  static let observationDurationSeconds = 240.0
  static let freshLocationMaximumAgeSeconds = 15.0
  static let maximumHorizontalAccuracyMeters = 15.0
  static let driveAwayMinimumDistanceMeters = 125.0
  static let driveAwayDistanceIncreaseMeters = 50.0
  static let driveAwayMinimumSpeedMetersPerSecond = 4.0
  static let driveAwayMaximumSpeedAccuracyMetersPerSecond = 1.0
}

struct PersistedSmartArrivalObservation: Codable, Equatable, Sendable {
  let identifier: String
  let placeId: String
  let registrationId: String
  let fingerprint: String
  let startedAt: String
  let deadline: String
  var closestAccurateDistanceMeters: Double?
  var automotiveEvidenceStartedAt: String?
  var walkingEvidenceStartedAt: String?
}

struct PersistedSmartArrivalDeliveryIntent: Codable, Equatable, Sendable {
  let placeId: String
  let observationIdentifier: String
  let registrationId: String
  let notificationId: String
  let fingerprint: String
  let createdAt: String
}

enum SmartArrivalMotionSource: Equatable, Sendable {
  case live
  case historicalQuery
  case authorizationPrompt
}

enum SmartArrivalMotionConfidence: Equatable, Sendable {
  case low
  case medium
  case high
}

struct SmartArrivalMotionEvidence: Sendable {
  let source: SmartArrivalMotionSource
  let receivedAt: Date
  let activityStartedAt: Date
  let automotive: Bool
  let walking: Bool
  let confidence: SmartArrivalMotionConfidence
}

struct SmartArrivalLocationEvidence: Sendable {
  let timestamp: Date
  let receivedAt: Date
  let coordinate: PersistedCoordinate
  let horizontalAccuracyMeters: Double
  let speedMetersPerSecond: Double?
  let speedAccuracyMetersPerSecond: Double?
}

struct SmartArrivalDeliveryRecovery: Sendable {
  let state: PersistedGeofenceState
  let intentsToSubmit: [PersistedSmartArrivalDeliveryIntent]
  let pendingNotificationIds: [String]
  let consumedNotificationIds: [String]
}

enum SmartArrivalPersistedStateError: LocalizedError {
  case invalid(String)

  var errorDescription: String? {
    switch self {
    case .invalid(let message):
      return "The persisted Smart Arrival state is invalid: \(message)"
    }
  }
}

enum SmartArrivalStateTransitions {
  static func validate(_ state: PersistedGeofenceState) throws {
    let requestsByPlaceId = Dictionary(
      uniqueKeysWithValues: state.requests.map { ($0.placeId, $0) }
    )
    let snapshotPlaceIds = Set(state.snapshot?.stores.map(\.placeId) ?? [])
    var observationIdentifiers = Set<String>()
    var observationPlaceIds = Set<String>()

    for observation in state.observations {
      guard
        isCanonicalObservationIdentifier(observation.identifier),
        observationIdentifiers.insert(observation.identifier).inserted,
        observationPlaceIds.insert(observation.placeId).inserted
      else {
        throw SmartArrivalPersistedStateError.invalid(
          "observations must have unique identifiers and stores."
        )
      }
      guard
        let startedAt = date(observation.startedAt),
        let deadline = date(observation.deadline),
        abs(
          deadline.timeIntervalSince(startedAt) -
            SmartArrivalConstants.observationDurationSeconds
        ) < 0.001
      else {
        throw SmartArrivalPersistedStateError.invalid(
          "an observation has an invalid absolute deadline."
        )
      }
      if let closest = observation.closestAccurateDistanceMeters,
        !isFiniteNonNegative(closest)
      {
        throw SmartArrivalPersistedStateError.invalid(
          "an observation has an invalid closest distance."
        )
      }
      for evidenceTimestamp in [
        observation.automotiveEvidenceStartedAt,
        observation.walkingEvidenceStartedAt
      ].compactMap({ $0 }) {
        guard
          let evidenceAt = date(evidenceTimestamp),
          evidenceAt >= startedAt,
          evidenceAt < deadline
        else {
          throw SmartArrivalPersistedStateError.invalid(
            "an observation has invalid motion evidence."
          )
        }
      }
      guard
        snapshotPlaceIds.contains(observation.placeId),
        let request = requestsByPlaceId[observation.placeId],
        request.status == .pending,
        request.installationId == observation.registrationId,
        request.fingerprint == observation.fingerprint
      else {
        throw SmartArrivalPersistedStateError.invalid(
          "an observation does not match a pending manifest entry."
        )
      }
    }

    var intentPlaceIds = Set<String>()
    var intentObservationIdentifiers = Set<String>()
    var notificationIds = Set<String>()
    for intent in state.deliveryIntents {
      guard
        intentPlaceIds.insert(intent.placeId).inserted,
        intentObservationIdentifiers.insert(
          intent.observationIdentifier
        ).inserted,
        isCanonicalObservationIdentifier(intent.observationIdentifier),
        !observationIdentifiers.contains(intent.observationIdentifier),
        notificationIds.insert(intent.notificationId).inserted,
        intent.notificationId == deliveryIdentifier(
          registrationId: intent.registrationId,
          observationIdentifier: intent.observationIdentifier
        ),
        date(intent.createdAt) != nil,
        !observationPlaceIds.contains(intent.placeId),
        snapshotPlaceIds.contains(intent.placeId),
        let request = requestsByPlaceId[intent.placeId],
        request.status == .pending,
        request.installationId == intent.registrationId,
        request.fingerprint == intent.fingerprint
      else {
        throw SmartArrivalPersistedStateError.invalid(
          "a delivery intent is duplicated or no longer matches the manifest."
        )
      }
    }
  }

  static func regionEntered(
    placeId: String,
    registrationId: String,
    observationIdentifier: String,
    at enteredAt: Date,
    in state: PersistedGeofenceState
  ) -> PersistedGeofenceState {
    var next = recover(state, at: enteredAt)
    let notificationId = deliveryIdentifier(
      registrationId: registrationId,
      observationIdentifier: observationIdentifier
    )
    guard
      isCanonicalObservationIdentifier(observationIdentifier),
      !next.observations.contains(where: {
        $0.identifier == observationIdentifier
      }),
      !next.deliveryIntents.contains(where: {
        $0.observationIdentifier == observationIdentifier ||
          $0.notificationId == notificationId
      }),
      next.deliveryIntents.allSatisfy({ $0.placeId != placeId }),
      !next.observations.contains(where: { $0.placeId == placeId }),
      next.snapshot?.stores.contains(where: { $0.placeId == placeId }) == true,
      let request = next.requests.first(where: { $0.placeId == placeId }),
      request.status == .pending,
      request.installationId == registrationId
    else {
      return next
    }

    next.observations.append(
      PersistedSmartArrivalObservation(
        identifier: observationIdentifier,
        placeId: placeId,
        registrationId: registrationId,
        fingerprint: request.fingerprint,
        startedAt: timestamp(enteredAt),
        deadline: timestamp(
          enteredAt.addingTimeInterval(
            SmartArrivalConstants.observationDurationSeconds
          )
        ),
        closestAccurateDistanceMeters: nil,
        automotiveEvidenceStartedAt: nil,
        walkingEvidenceStartedAt: nil
      )
    )
    sortTransientState(&next)
    return next
  }

  static func motionObserved(
    _ evidence: SmartArrivalMotionEvidence,
    latestLocation: SmartArrivalLocationEvidence?,
    in state: PersistedGeofenceState
  ) -> PersistedGeofenceState {
    var next = recover(state, at: evidence.receivedAt)
    guard
      evidence.source == .live || evidence.source == .historicalQuery,
      evidence.confidence == .high,
      evidence.activityStartedAt <= evidence.receivedAt
    else {
      return next
    }

    for index in next.observations.indices {
      guard
        let startedAt = date(next.observations[index].startedAt),
        let deadline = date(next.observations[index].deadline),
        evidence.activityStartedAt >= startedAt,
        evidence.activityStartedAt < deadline
      else {
        continue
      }
      if evidence.automotive && !evidence.walking {
        next.observations[index].automotiveEvidenceStartedAt = timestamp(
          evidence.activityStartedAt
        )
      }
      if evidence.walking && !evidence.automotive,
        next.observations[index].walkingEvidenceStartedAt == nil
      {
        next.observations[index].walkingEvidenceStartedAt = timestamp(
          evidence.activityStartedAt
        )
      }
    }

    guard let latestLocation else {
      return next
    }
    return applyLocation(
      latestLocation,
      decisionAt: evidence.receivedAt,
      to: next
    )
  }

  static func locationObserved(
    _ evidence: SmartArrivalLocationEvidence,
    in state: PersistedGeofenceState
  ) -> PersistedGeofenceState {
    applyLocation(evidence, decisionAt: evidence.receivedAt, to: state)
  }

  static func invalidate(
    _ state: PersistedGeofenceState,
    desiredFingerprintsByPlaceId: [String: String]? = nil
  ) -> PersistedGeofenceState {
    var next = state
    let requestsByPlaceId = Dictionary(
      uniqueKeysWithValues: next.requests.map { ($0.placeId, $0) }
    )
    let snapshotPlaceIds = Set(next.snapshot?.stores.map(\.placeId) ?? [])

    next.observations.removeAll { observation in
      guard
        snapshotPlaceIds.contains(observation.placeId),
        let request = requestsByPlaceId[observation.placeId]
      else {
        return true
      }
      return request.status != .pending ||
        request.installationId != observation.registrationId ||
        request.fingerprint != observation.fingerprint ||
        (desiredFingerprintsByPlaceId.map {
          $0[observation.placeId] != observation.fingerprint
        } ?? false)
    }
    next.deliveryIntents.removeAll { intent in
      guard
        snapshotPlaceIds.contains(intent.placeId),
        let request = requestsByPlaceId[intent.placeId]
      else {
        return true
      }
      return request.status != .pending ||
        request.installationId != intent.registrationId ||
        request.fingerprint != intent.fingerprint ||
        (desiredFingerprintsByPlaceId.map {
          $0[intent.placeId] != intent.fingerprint
        } ?? false)
    }
    return next
  }

  static func sanitizedForPersistence(
    _ state: PersistedGeofenceState,
    desiredFingerprintsByPlaceId: [String: String]? = nil
  ) -> PersistedGeofenceState {
    var next = invalidate(
      state,
      desiredFingerprintsByPlaceId: desiredFingerprintsByPlaceId
    )
    do {
      try validate(next)
      return next
    } catch {
      next.observations = []
      next.deliveryIntents = []
      return next
    }
  }

  static func recover(
    _ state: PersistedGeofenceState,
    at now: Date
  ) -> PersistedGeofenceState {
    var next = invalidate(state)
    next.observations.removeAll { observation in
      guard let deadline = date(observation.deadline) else {
        return true
      }
      return now >= deadline
    }
    return next
  }

  static func recoverDeliveries(
    _ state: PersistedGeofenceState,
    at now: Date,
    pendingNotificationIds: Set<String>,
    deliveredNotificationIds: Set<String>
  ) -> SmartArrivalDeliveryRecovery {
    var next = recover(state, at: now)
    var consumedNotificationIds: [String] = []

    for intent in next.deliveryIntents where
      deliveredNotificationIds.contains(intent.notificationId)
    {
      next = deliveryConsumed(
        notificationId: intent.notificationId,
        in: next
      )
      consumedNotificationIds.append(intent.notificationId)
    }

    let pendingIds = next.deliveryIntents
      .map(\.notificationId)
      .filter(pendingNotificationIds.contains)
      .sorted()
    let intentsToSubmit = next.deliveryIntents
      .filter {
        !pendingNotificationIds.contains($0.notificationId)
      }
      .sorted {
        stringPrecedes($0.registrationId, $1.registrationId)
      }

    return SmartArrivalDeliveryRecovery(
      state: next,
      intentsToSubmit: intentsToSubmit,
      pendingNotificationIds: pendingIds,
      consumedNotificationIds: consumedNotificationIds.sorted()
    )
  }

  static func deliveryConsumed(
    notificationId: String,
    in state: PersistedGeofenceState
  ) -> PersistedGeofenceState {
    var next = state
    guard
      let intent = next.deliveryIntents.first(where: {
        $0.notificationId == notificationId
      })
    else {
      return next
    }

    if let requestIndex = next.requests.firstIndex(where: {
      $0.placeId == intent.placeId &&
        $0.installationId == intent.registrationId &&
        $0.fingerprint == intent.fingerprint
    }) {
      next.requests[requestIndex].status = .consumed
    }
    next.deliveryIntents.removeAll { $0.notificationId == notificationId }
    next.observations.removeAll { $0.placeId == intent.placeId }
    return next
  }

  private static func applyLocation(
    _ evidence: SmartArrivalLocationEvidence,
    decisionAt: Date,
    to state: PersistedGeofenceState
  ) -> PersistedGeofenceState {
    var next = recover(state, at: decisionAt)
    guard accurateAndFresh(evidence, at: decisionAt) else {
      return next
    }

    let storesByPlaceId = Dictionary(
      uniqueKeysWithValues: (next.snapshot?.stores ?? []).map {
        ($0.placeId, $0)
      }
    )
    var retainedObservations: [PersistedSmartArrivalObservation] = []

    for var observation in next.observations {
      guard let store = storesByPlaceId[observation.placeId] else {
        continue
      }
      guard
        let observationStartedAt = date(observation.startedAt),
        decisionAt >= observationStartedAt,
        evidence.timestamp >= observationStartedAt
      else {
        retainedObservations.append(observation)
        continue
      }
      let distance = distanceBetween(evidence.coordinate, store.location)
      let previousClosest = observation.closestAccurateDistanceMeters
      if previousClosest == nil || distance < previousClosest ?? .infinity {
        observation.closestAccurateDistanceMeters = distance
      }

      if observation.automotiveEvidenceStartedAt != nil,
        let previousClosest,
        qualifiesAsDriveAway(
          evidence,
          distanceMeters: distance,
          previousClosestDistanceMeters: previousClosest
        )
      {
        continue
      }

      if observation.walkingEvidenceStartedAt != nil,
        distance <= GeofenceNotificationConstants.radiusMeters
      {
        next.deliveryIntents.append(
          PersistedSmartArrivalDeliveryIntent(
            placeId: observation.placeId,
            observationIdentifier: observation.identifier,
            registrationId: observation.registrationId,
            notificationId: deliveryIdentifier(
              registrationId: observation.registrationId,
              observationIdentifier: observation.identifier
            ),
            fingerprint: observation.fingerprint,
            createdAt: timestamp(decisionAt)
          )
        )
        continue
      }

      retainedObservations.append(observation)
    }

    next.observations = retainedObservations
    sortTransientState(&next)
    return next
  }

  private static func qualifiesAsDriveAway(
    _ evidence: SmartArrivalLocationEvidence,
    distanceMeters: Double,
    previousClosestDistanceMeters: Double
  ) -> Bool {
    guard
      let speed = evidence.speedMetersPerSecond,
      speed.isFinite,
      speed >= SmartArrivalConstants.driveAwayMinimumSpeedMetersPerSecond,
      let speedAccuracy = evidence.speedAccuracyMetersPerSecond,
      isFiniteNonNegative(speedAccuracy),
      speedAccuracy <=
        SmartArrivalConstants.driveAwayMaximumSpeedAccuracyMetersPerSecond,
      distanceMeters >= SmartArrivalConstants.driveAwayMinimumDistanceMeters,
      distanceMeters >=
        previousClosestDistanceMeters +
          SmartArrivalConstants.driveAwayDistanceIncreaseMeters
    else {
      return false
    }
    return true
  }

  private static func accurateAndFresh(
    _ evidence: SmartArrivalLocationEvidence,
    at now: Date
  ) -> Bool {
    let age = now.timeIntervalSince(evidence.timestamp)
    return
      CLLocationCoordinate2DIsValid(
        CLLocationCoordinate2D(
          latitude: evidence.coordinate.latitude,
          longitude: evidence.coordinate.longitude
        )
      ) &&
      isFiniteNonNegative(evidence.horizontalAccuracyMeters) &&
      evidence.horizontalAccuracyMeters <=
        SmartArrivalConstants.maximumHorizontalAccuracyMeters &&
      age >= 0 &&
      age <= SmartArrivalConstants.freshLocationMaximumAgeSeconds
  }

  private static func distanceBetween(
    _ left: PersistedCoordinate,
    _ right: PersistedCoordinate
  ) -> CLLocationDistance {
    CLLocation(latitude: left.latitude, longitude: left.longitude).distance(
      from: CLLocation(latitude: right.latitude, longitude: right.longitude)
    )
  }

  private static func deliveryIdentifier(
    registrationId: String,
    observationIdentifier: String
  ) -> String {
    [
      GeofenceNotificationConstants.deliveryIdentifierPrefix,
      "\(registrationId.utf16.count):",
      registrationId,
      ".",
      observationIdentifier
    ].joined()
  }

  private static func sortTransientState(
    _ state: inout PersistedGeofenceState
  ) {
    state.observations.sort {
      stringPrecedes($0.registrationId, $1.registrationId)
    }
    state.deliveryIntents.sort {
      stringPrecedes($0.registrationId, $1.registrationId)
    }
  }

  private static func stringPrecedes(_ left: String, _ right: String) -> Bool {
    left.utf16.lexicographicallyPrecedes(right.utf16)
  }

  private static func isCanonicalObservationIdentifier(
    _ identifier: String
  ) -> Bool {
    guard let uuid = UUID(uuidString: identifier) else {
      return false
    }
    return uuid.uuidString.lowercased() == identifier
  }

  private static func isFiniteNonNegative(_ value: Double) -> Bool {
    value.isFinite && value >= 0
  }

  private static func timestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private static func date(_ value: String) -> Date? {
    let pattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      return nil
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    guard let result = formatter.date(from: value) else {
      return nil
    }
    return formatter.string(from: result) == value ? result : nil
  }
}
