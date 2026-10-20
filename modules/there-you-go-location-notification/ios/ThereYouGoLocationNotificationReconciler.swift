import CoreLocation
import CryptoKit
import Foundation
import UserNotifications

// Runtime owner of snapshot validation, item-aware selection, persistence, and
// UNUserNotificationCenter reconciliation. This repository has no XCTest target
// for local Expo modules; see TESTING.md for the manual device procedure.

enum GeofenceNotificationConstants {
  static let stateSchemaVersion = 2
  static let previousStateSchemaVersion = 1
  static let candidateSchemaVersion = 1
  static let radiusMeters = 100.0
  static let duplicateStoreDistanceMeters = 30.0
  static let maximumSelectedStores = 15
  static let maximumLocationTriggers = 20
  static let managedIdentifierPrefix = "tyg.arrival.v1."
  static let deliveryIdentifierPrefix = "tyg.arrival.delivery.v1."
  static let userDefaultsKey = "there-you-go.location-notifications.state.v1"
  static let quarantinedUserDefaultsKey =
    "there-you-go.location-notifications.state.quarantined"

  static let maximumItems = 500
  static let maximumStores = 500
  static let maximumIdentifierLength = 512
  static let maximumItemTextLength = 500
  static let maximumStoreNameLength = 256
  static let maximumCategoriesPerItem = 10
  static let maximumDisplayedItemLength = 80
  static let maximumNotificationBodyLength = 180
  static let maximumNamedItemsInBody = 3

  static let categoryOrder = [
    "grocery-store",
    "convenience-store",
    "pharmacy",
    "pet-store",
    "hardware-store",
    "electronics-store",
    "department-store",
    "clothing-store",
    "auto-parts-store",
    "home-goods-store"
  ]
}

enum ManagedRequestStatus: String, Codable, Sendable {
  case pending
  case consumed
}

struct PersistedCoordinate: Codable, Equatable, Sendable {
  let latitude: Double
  let longitude: Double
}

struct PersistedCandidateItem: Codable, Equatable, Sendable {
  let id: String
  let revision: Int
  let text: String
  let categories: [String]
}

struct PersistedCandidateStore: Codable, Equatable, Sendable {
  let placeId: String
  let name: String
  let location: PersistedCoordinate
  let itemIds: [String]
}

struct PersistedCandidateSnapshot: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let generatedAt: String
  let discoveryAnchor: PersistedCoordinate
  let items: [PersistedCandidateItem]
  let stores: [PersistedCandidateStore]
}

struct PersistedItemReference: Codable, Equatable, Sendable {
  let id: String
  let revision: Int
}

struct PersistedRequestManifestEntry: Codable, Equatable, Sendable {
  let placeId: String
  let installationId: String
  let fingerprint: String
  var status: ManagedRequestStatus
  let itemReferences: [PersistedItemReference]
}

struct PersistedCancellationIntent: Codable, Equatable, Sendable {
  let placeId: String
  let installationId: String
}

struct PersistedGeofenceStateV1: Codable, Sendable {
  let schemaVersion: Int
  var snapshot: PersistedCandidateSnapshot?
  var requests: [PersistedRequestManifestEntry]
  var pendingCancellations: [PersistedCancellationIntent]

  private enum CodingKeys: String, CodingKey {
    case schemaVersion
    case snapshot
    case requests
    case pendingCancellations
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    snapshot = try container.decodeIfPresent(
      PersistedCandidateSnapshot.self,
      forKey: .snapshot
    )
    requests = try container.decode(
      [PersistedRequestManifestEntry].self,
      forKey: .requests
    )
    pendingCancellations = try container.decodeIfPresent(
      [PersistedCancellationIntent].self,
      forKey: .pendingCancellations
    ) ?? []
  }
}

struct PersistedGeofenceState: Codable, Sendable {
  let schemaVersion: Int
  var snapshot: PersistedCandidateSnapshot?
  var requests: [PersistedRequestManifestEntry]
  var pendingCancellations: [PersistedCancellationIntent]
  var observations: [PersistedSmartArrivalObservation]
  var deliveryIntents: [PersistedSmartArrivalDeliveryIntent]

  static var empty: PersistedGeofenceState {
    PersistedGeofenceState(
      schemaVersion: GeofenceNotificationConstants.stateSchemaVersion,
      snapshot: nil,
      requests: [],
      pendingCancellations: [],
      observations: [],
      deliveryIntents: []
    )
  }

  init(
    schemaVersion: Int,
    snapshot: PersistedCandidateSnapshot?,
    requests: [PersistedRequestManifestEntry],
    pendingCancellations: [PersistedCancellationIntent],
    observations: [PersistedSmartArrivalObservation],
    deliveryIntents: [PersistedSmartArrivalDeliveryIntent]
  ) {
    self.schemaVersion = schemaVersion
    self.snapshot = snapshot
    self.requests = requests
    self.pendingCancellations = pendingCancellations
    self.observations = observations
    self.deliveryIntents = deliveryIntents
  }
}

struct DesiredStoreNotification: Sendable {
  let placeId: String
  let name: String
  let location: PersistedCoordinate
  let distanceMeters: Double
  let itemReferences: [PersistedItemReference]
  let itemIds: [String]
  let itemRevisions: [String: Int]
  let title: String
  let body: String
  let fingerprint: String
  let snapshotGeneratedAt: String
}

struct NativeReconciliationFailure: Sendable {
  let placeId: String
  let code: String
  let message: String
}

struct NativeRequestView: Sendable {
  let placeId: String
  let installationId: String
  let fingerprint: String
  let status: ManagedRequestStatus
  let itemReferences: [PersistedItemReference]
  let isPending: Bool
}

struct NativeGeofenceStateView: Sendable {
  let snapshot: PersistedCandidateSnapshot?
  let requests: [NativeRequestView]
  let selectedPlaceIds: [String]
  let pendingManagedRequestIds: [String]
  let isDegraded: Bool
}

struct NativeSyncReport: Sendable {
  let scheduledPlaceIds: [String]
  let unchangedPlaceIds: [String]
  let canceledPlaceIds: [String]
  let consumedPlaceIds: [String]
  let retainedFallbackPlaceIds: [String]
  let failures: [NativeReconciliationFailure]
  let state: NativeGeofenceStateView
}

enum CandidateSnapshotValidationError: LocalizedError {
  case invalid(String)

  var errorDescription: String? {
    switch self {
    case .invalid(let message):
      return "Invalid geofence candidate snapshot: \(message)"
    }
  }
}

enum PersistedGeofenceStateError: LocalizedError {
  case unsupportedVersion
  case duplicatePlaceId
  case unmanagedIdentifier

  var errorDescription: String? {
    switch self {
    case .unsupportedVersion:
      return "The persisted geofence state uses an unsupported schema version."
    case .duplicatePlaceId:
      return "The persisted geofence request manifest contains duplicate stores."
    case .unmanagedIdentifier:
      return "The persisted geofence request manifest contains an invalid installation identifier."
    }
  }
}

enum CandidateSnapshotValidator {
  static func validate(
    _ record: CandidateSnapshotInputRecord
  ) throws -> PersistedCandidateSnapshot {
    guard
      let schemaVersion = record.schemaVersion,
      let generatedAt = record.generatedAt,
      let discoveryAnchor = record.discoveryAnchor,
      let anchorLatitude = discoveryAnchor.latitude,
      let anchorLongitude = discoveryAnchor.longitude,
      let itemRecords = record.items,
      let storeRecords = record.stores
    else {
      throw CandidateSnapshotValidationError.invalid(
        "all snapshot fields are required."
      )
    }
    guard schemaVersion == GeofenceNotificationConstants.candidateSchemaVersion else {
      throw CandidateSnapshotValidationError.invalid("unsupported schemaVersion.")
    }
    guard iso8601Date(generatedAt) != nil else {
      throw CandidateSnapshotValidationError.invalid(
        "generatedAt must be a canonical ISO-8601 UTC timestamp."
      )
    }
    let anchor = try coordinate(
      latitude: anchorLatitude,
      longitude: anchorLongitude,
      field: "discoveryAnchor"
    )
    guard itemRecords.count <= GeofenceNotificationConstants.maximumItems else {
      throw CandidateSnapshotValidationError.invalid("too many items.")
    }
    guard storeRecords.count <= GeofenceNotificationConstants.maximumStores else {
      throw CandidateSnapshotValidationError.invalid("too many stores.")
    }

    let categoryOrder = Dictionary(
      uniqueKeysWithValues: GeofenceNotificationConstants.categoryOrder.enumerated().map {
        ($0.element, $0.offset)
      }
    )
    let knownCategories = Set(GeofenceNotificationConstants.categoryOrder)
    var itemIds = Set<String>()
    var items: [PersistedCandidateItem] = []

    for item in itemRecords {
      guard
        let id = item.id,
        let revision = item.revision,
        let text = item.text,
        let categories = item.categories
      else {
        throw CandidateSnapshotValidationError.invalid(
          "all item fields are required."
        )
      }
      try validateIdentifier(id, field: "item id")
      guard itemIds.insert(id).inserted else {
        throw CandidateSnapshotValidationError.invalid("item ids must be unique.")
      }
      guard revision > 0 else {
        throw CandidateSnapshotValidationError.invalid("item revisions must be positive.")
      }
      try validateText(
        text,
        field: "item text",
        maximumLength: GeofenceNotificationConstants.maximumItemTextLength
      )
      guard
        !categories.isEmpty,
        categories.count <= GeofenceNotificationConstants.maximumCategoriesPerItem
      else {
        throw CandidateSnapshotValidationError.invalid("items must have one or more categories.")
      }
      guard Set(categories).count == categories.count else {
        throw CandidateSnapshotValidationError.invalid("item categories must be unique.")
      }
      guard categories.allSatisfy(knownCategories.contains) else {
        throw CandidateSnapshotValidationError.invalid("an item contains an unknown category.")
      }

      items.append(
        PersistedCandidateItem(
          id: id,
          revision: revision,
          text: text,
          categories: categories.sorted {
            (categoryOrder[$0] ?? Int.max) < (categoryOrder[$1] ?? Int.max)
          }
        )
      )
    }
    items.sort { $0.id < $1.id }

    var placeIds = Set<String>()
    var stores: [PersistedCandidateStore] = []
    for store in storeRecords {
      guard
        let placeId = store.placeId,
        let name = store.name,
        let location = store.location,
        let latitude = location.latitude,
        let longitude = location.longitude,
        let storeItemIds = store.itemIds
      else {
        throw CandidateSnapshotValidationError.invalid(
          "all store fields are required."
        )
      }
      try validateIdentifier(placeId, field: "placeId")
      guard placeIds.insert(placeId).inserted else {
        throw CandidateSnapshotValidationError.invalid("placeIds must be unique.")
      }
      try validateText(
        name,
        field: "store name",
        maximumLength: GeofenceNotificationConstants.maximumStoreNameLength
      )
      let storeCoordinate = try coordinate(
        latitude: latitude,
        longitude: longitude,
        field: "store location"
      )
      guard !storeItemIds.isEmpty else {
        throw CandidateSnapshotValidationError.invalid("stores must reference at least one item.")
      }
      guard Set(storeItemIds).count == storeItemIds.count else {
        throw CandidateSnapshotValidationError.invalid("store itemIds must be unique.")
      }
      guard storeItemIds.allSatisfy(itemIds.contains) else {
        throw CandidateSnapshotValidationError.invalid("a store references an unknown item.")
      }

      stores.append(
        PersistedCandidateStore(
          placeId: placeId,
          name: name,
          location: storeCoordinate,
          itemIds: storeItemIds.sorted()
        )
      )
    }
    stores.sort { $0.placeId < $1.placeId }

    return PersistedCandidateSnapshot(
      schemaVersion: GeofenceNotificationConstants.candidateSchemaVersion,
      generatedAt: generatedAt,
      discoveryAnchor: anchor,
      items: items,
      stores: stores
    )
  }

  private static func coordinate(
    latitude: Double,
    longitude: Double,
    field: String
  ) throws -> PersistedCoordinate {
    let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    guard
      latitude.isFinite,
      longitude.isFinite,
      CLLocationCoordinate2DIsValid(coordinate)
    else {
      throw CandidateSnapshotValidationError.invalid("\(field) is invalid.")
    }
    return PersistedCoordinate(latitude: latitude, longitude: longitude)
  }

  private static func validateIdentifier(_ value: String, field: String) throws {
    try validateText(
      value,
      field: field,
      maximumLength: GeofenceNotificationConstants.maximumIdentifierLength
    )
  }

  private static func validateText(
    _ value: String,
    field: String,
    maximumLength: Int
  ) throws {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw CandidateSnapshotValidationError.invalid("\(field) must not be empty.")
    }
    guard value.count <= maximumLength else {
      throw CandidateSnapshotValidationError.invalid("\(field) is too long.")
    }
  }

  static func iso8601Date(_ value: String) -> Date? {
    let pattern =
      #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      return nil
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    guard let date = formatter.date(from: value) else {
      return nil
    }
    return formatter.string(from: date) == value ? date : nil
  }
}

actor ThereYouGoLocationNotificationReconciler {
  private let notificationCenter = UNUserNotificationCenter.current()
  private let encoder: JSONEncoder
  private let decoder = JSONDecoder()
  private var operationInProgress = false
  private var operationWaiters: [CheckedContinuation<Void, Never>] = []

  init() {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    self.encoder = encoder
  }

  func sync(snapshot: PersistedCandidateSnapshot) async throws -> NativeSyncReport {
    await acquireOperation()
    defer { releaseOperation() }
    return try await performSync(snapshot: snapshot)
  }

  private func performSync(
    snapshot: PersistedCandidateSnapshot
  ) async throws -> NativeSyncReport {
    var state = try loadState()
    var scheduledPlaceIds: [String] = []
    var unchangedPlaceIds: [String] = []
    var canceledPlaceIds: [String] = []
    var consumedPlaceIds: [String] = []
    var retainedFallbackPlaceIds: [String] = []
    var failures: [NativeReconciliationFailure] = []

    let failedRecoveredCancellations = try await recoverPendingCancellations(
      state: &state
    )
    failures.append(contentsOf: failedRecoveredCancellations.map { intent in
      NativeReconciliationFailure(
        placeId: intent.placeId,
        code: "cleanup-pending",
        message: "A previously interrupted cancellation is still pending."
      )
    })
    try validateSnapshotFreshness(snapshot, previous: state.snapshot)

    var pendingRequests = await notificationCenter.pendingNotificationRequests()
    var entries = try manifestByPlaceId(state.requests)

    for placeId in entries.keys.sorted() {
      guard var entry = entries[placeId] else {
        continue
      }
      let isPending = pendingRequests.contains(where: {
        $0.identifier == entry.installationId
      })
      let hasCancellationIntent = state.pendingCancellations.contains(where: {
        $0.installationId == entry.installationId
      })
      if entry.status == .pending && !isPending && !hasCancellationIntent {
        // One-shot delivery, user-cleared delivery, and OS removal are
        // indistinguishable. Keep a same-fingerprint tombstone and do not rearm.
        entry.status = .consumed
        entries[placeId] = entry
      } else if entry.status == .consumed && isPending {
        let intent = PersistedCancellationIntent(
          placeId: placeId,
          installationId: entry.installationId
        )
        addCancellationIntent(
          placeId: intent.placeId,
          installationId: intent.installationId,
          state: &state
        )
        state.requests = sortedManifest(entries)
        try saveState(&state)
        if try await executeCancellation(intent, state: &state) == false {
          failures.append(
            NativeReconciliationFailure(
              placeId: placeId,
              code: "cancel-failed",
              message: "A consumed request could not be removed."
            )
          )
        }
      }
    }
    state.requests = sortedManifest(entries)
    try saveState(&state)

    let knownInstallationIds = Set(
      entries.values.map(\.installationId) +
        state.pendingCancellations.map(\.installationId)
    )
    let orphanIds = pendingRequests
      .map(\.identifier)
      .filter {
        isManagedIdentifier($0) && !knownInstallationIds.contains($0)
      }
    for orphanId in uniqueSorted(orphanIds) {
      let intent = PersistedCancellationIntent(
        placeId: "",
        installationId: orphanId
      )
      addCancellationIntent(
        placeId: intent.placeId,
        installationId: intent.installationId,
        state: &state
      )
      try saveState(&state)
      if try await executeCancellation(intent, state: &state) == false {
        failures.append(
          NativeReconciliationFailure(
            placeId: "",
            code: "orphan-cancel-failed",
            message: "An orphaned managed request could not be removed."
          )
        )
      }
    }

    pendingRequests = await notificationCenter.pendingNotificationRequests()
    let desiredPool = try desiredNotifications(from: snapshot)
    let desiredByPlaceId = Dictionary(
      uniqueKeysWithValues: desiredPool.map { ($0.placeId, $0) }
    )
    let selected = Array(
      desiredPool.prefix(GeofenceNotificationConstants.maximumSelectedStores)
    )
    let selectedPlaceIds = Set(selected.map(\.placeId))
    let snapshotItemsById = Dictionary(
      uniqueKeysWithValues: snapshot.items.map {
        ($0.id, $0.revision)
      }
    )
    for placeId in entries.keys.sorted() {
      guard
        let entry = entries[placeId],
        entry.status == .consumed,
        !itemReferencesRemainEligible(
          entry.itemReferences,
          itemsById: snapshotItemsById
        )
      else {
        continue
      }
      entries.removeValue(forKey: placeId)
    }
    var blockedPlaceIds = Set<String>()

    // Requests whose item membership changed are unsafe. Remove them before installing
    // replacements so completed, edited, or deleted item text cannot still fire.
    for placeId in entries.keys.sorted() {
      guard
        let entry = entries[placeId],
        entry.status == .pending,
        pendingRequests.contains(where: { $0.identifier == entry.installationId })
      else {
        continue
      }
      let currentCandidate = desiredByPlaceId[placeId]
      let lifecycleInvalid =
        currentCandidate == nil ||
        currentCandidate?.itemReferences != entry.itemReferences
      guard lifecycleInvalid else {
        continue
      }

      entries.removeValue(forKey: placeId)
      let intent = PersistedCancellationIntent(
        placeId: placeId,
        installationId: entry.installationId
      )
      addCancellationIntent(
        placeId: intent.placeId,
        installationId: intent.installationId,
        state: &state
      )
      state.requests = sortedManifest(entries)
      try saveState(&state)
      if try await executeCancellation(intent, state: &state) {
        canceledPlaceIds.append(placeId)
      } else {
        blockedPlaceIds.insert(placeId)
        failures.append(
          NativeReconciliationFailure(
            placeId: placeId,
            code: "lifecycle-cancel-failed",
            message: "A lifecycle-invalid request could not be removed."
          )
        )
      }
    }

    state.snapshot = snapshot
    state.requests = sortedManifest(entries)
    try saveState(&state)
    pendingRequests = await notificationCenter.pendingNotificationRequests()

    for desired in selected {
      if blockedPlaceIds.contains(desired.placeId) {
        continue
      }

      let oldEntry = entries[desired.placeId]
      let oldPendingRequest = oldEntry.flatMap { entry in
        pendingRequests.first(where: { $0.identifier == entry.installationId })
      }

      if let entry = oldEntry,
        entry.status == .consumed,
        entry.fingerprint == desired.fingerprint {
        consumedPlaceIds.append(desired.placeId)
        continue
      }

      if let entry = oldEntry,
        entry.status == .pending,
        entry.fingerprint == desired.fingerprint,
        let request = oldPendingRequest,
        verify(request: request, matches: desired) {
        unchangedPlaceIds.append(desired.placeId)
        continue
      }

      var locationTriggerCount = pendingRequests.filter {
        $0.trigger is UNLocationNotificationTrigger
      }.count
      if
        locationTriggerCount >= GeofenceNotificationConstants.maximumLocationTriggers,
        let retirement = retirementCandidate(
          entries: entries,
          selectedPlaceIds: selectedPlaceIds,
          desiredByPlaceId: desiredByPlaceId,
          pendingRequests: pendingRequests
        )
      {
        entries.removeValue(forKey: retirement.placeId)
        let intent = PersistedCancellationIntent(
          placeId: retirement.placeId,
          installationId: retirement.installationId
        )
        addCancellationIntent(
          placeId: intent.placeId,
          installationId: intent.installationId,
          state: &state
        )
        state.requests = sortedManifest(entries)
        try saveState(&state)
        if try await executeCancellation(intent, state: &state) {
          canceledPlaceIds.append(retirement.placeId)
        } else {
          failures.append(
            NativeReconciliationFailure(
              placeId: retirement.placeId,
              code: "capacity-retirement-failed",
              message: "A managed fallback could not be retired to free region capacity."
            )
          )
        }
        pendingRequests = await notificationCenter.pendingNotificationRequests()
        locationTriggerCount = pendingRequests.filter {
          $0.trigger is UNLocationNotificationTrigger
        }.count
      }

      guard locationTriggerCount < GeofenceNotificationConstants.maximumLocationTriggers else {
        failures.append(
          NativeReconciliationFailure(
            placeId: desired.placeId,
            code: "region-capacity",
            message: "No region-monitoring capacity is available for a verified replacement."
          )
        )
        if oldPendingRequest != nil {
          retainedFallbackPlaceIds.append(desired.placeId)
        }
        continue
      }

      let installationId = makeInstallationId(placeId: desired.placeId)
      let request = makeNotificationRequest(
        installationId: installationId,
        desired: desired
      )

      do {
        try await notificationCenter.add(request)
      } catch {
        failures.append(
          NativeReconciliationFailure(
            placeId: desired.placeId,
            code: "schedule-failed",
            message: error.localizedDescription
          )
        )
        if oldPendingRequest != nil {
          retainedFallbackPlaceIds.append(desired.placeId)
        }
        continue
      }

      let requestsAfterAdd = await notificationCenter.pendingNotificationRequests()
      guard
        let verifiedRequest = requestsAfterAdd.first(where: {
          $0.identifier == installationId
        }),
        verify(request: verifiedRequest, matches: desired)
      else {
        let intent = PersistedCancellationIntent(
          placeId: desired.placeId,
          installationId: installationId
        )
        addCancellationIntent(
          placeId: intent.placeId,
          installationId: intent.installationId,
          state: &state
        )
        try saveState(&state)
        _ = try await executeCancellation(intent, state: &state)
        failures.append(
          NativeReconciliationFailure(
            placeId: desired.placeId,
            code: "verification-failed",
            message: "The newly scheduled request did not match its desired configuration."
          )
        )
        if oldPendingRequest != nil {
          retainedFallbackPlaceIds.append(desired.placeId)
        }
        pendingRequests = await notificationCenter.pendingNotificationRequests()
        continue
      }

      entries[desired.placeId] = PersistedRequestManifestEntry(
        placeId: desired.placeId,
        installationId: installationId,
        fingerprint: desired.fingerprint,
        status: .pending,
        itemReferences: desired.itemReferences
      )
      if let oldEntry, oldEntry.status == .pending,
        oldEntry.installationId != installationId {
        addCancellationIntent(
          placeId: desired.placeId,
          installationId: oldEntry.installationId,
          state: &state
        )
      }
      state.requests = sortedManifest(entries)
      try saveState(&state)
      scheduledPlaceIds.append(desired.placeId)

      if let oldEntry, oldEntry.status == .pending,
        oldEntry.installationId != installationId {
        let intent = PersistedCancellationIntent(
          placeId: desired.placeId,
          installationId: oldEntry.installationId
        )
        if try await executeCancellation(intent, state: &state) == false {
          failures.append(
            NativeReconciliationFailure(
              placeId: desired.placeId,
              code: "replacement-cleanup-failed",
              message: "The verified replacement was installed, but the old request remains pending."
            )
          )
        }
      }

      pendingRequests = await notificationCenter.pendingNotificationRequests()
    }

    pendingRequests = await notificationCenter.pendingNotificationRequests()
    let missingSelectedCount = selected.filter {
      !isSatisfied(
        desired: $0,
        entry: entries[$0.placeId],
        pendingRequests: pendingRequests
      )
    }.count
    let samePlaceFallbackCount = selected.filter {
      guard
        let entry = entries[$0.placeId],
        entry.status == .pending,
        entry.fingerprint != $0.fingerprint
      else {
        return false
      }
      return pendingRequests.contains(where: {
        $0.identifier == entry.installationId
      })
    }.count
    var availableFallbackSlots = max(0, missingSelectedCount - samePlaceFallbackCount)
    let unselectedPendingEntries = entries.values
      .filter { entry in
        entry.status == .pending &&
          !selectedPlaceIds.contains(entry.placeId) &&
          pendingRequests.contains(where: {
            $0.identifier == entry.installationId
          })
      }
      .sorted { left, right in
        let leftDistance = desiredByPlaceId[left.placeId]?.distanceMeters ?? .greatestFiniteMagnitude
        let rightDistance = desiredByPlaceId[right.placeId]?.distanceMeters ?? .greatestFiniteMagnitude
        if leftDistance != rightDistance {
          return leftDistance < rightDistance
        }
        return left.placeId < right.placeId
      }

    for entry in unselectedPendingEntries {
      if
        availableFallbackSlots > 0,
        desiredByPlaceId[entry.placeId] != nil
      {
        retainedFallbackPlaceIds.append(entry.placeId)
        availableFallbackSlots -= 1
        continue
      }

      entries.removeValue(forKey: entry.placeId)
      let intent = PersistedCancellationIntent(
        placeId: entry.placeId,
        installationId: entry.installationId
      )
      addCancellationIntent(
        placeId: intent.placeId,
        installationId: intent.installationId,
        state: &state
      )
      state.requests = sortedManifest(entries)
      try saveState(&state)
      if try await executeCancellation(intent, state: &state) {
        canceledPlaceIds.append(entry.placeId)
      } else {
        failures.append(
          NativeReconciliationFailure(
            placeId: entry.placeId,
            code: "cancel-failed",
            message: "An unselected request could not be removed."
          )
        )
      }
    }

    state.requests = sortedManifest(entries)
    try saveState(&state)
    let finalPendingRequests = await notificationCenter.pendingNotificationRequests()
    let stateView = makeStateView(
      state: state,
      pendingRequests: finalPendingRequests
    )

    return NativeSyncReport(
      scheduledPlaceIds: uniqueSorted(scheduledPlaceIds),
      unchangedPlaceIds: uniqueSorted(unchangedPlaceIds),
      canceledPlaceIds: uniqueSorted(canceledPlaceIds),
      consumedPlaceIds: uniqueSorted(consumedPlaceIds),
      retainedFallbackPlaceIds: uniqueSorted(retainedFallbackPlaceIds),
      failures: failures,
      state: stateView
    )
  }

  func getState() async throws -> NativeGeofenceStateView {
    await acquireOperation()
    defer { releaseOperation() }
    return try await performGetState()
  }

  private func performGetState() async throws -> NativeGeofenceStateView {
    var state = try loadState()
    _ = try await recoverPendingCancellations(state: &state)
    var entries = try manifestByPlaceId(state.requests)
    var pendingRequests = await notificationCenter.pendingNotificationRequests()

    for placeId in entries.keys.sorted() {
      guard var entry = entries[placeId] else {
        continue
      }
      let isPending = pendingRequests.contains(where: {
        $0.identifier == entry.installationId
      })
      let hasCancellationIntent = state.pendingCancellations.contains(where: {
        $0.installationId == entry.installationId
      })
      if entry.status == .pending && !isPending && !hasCancellationIntent {
        entry.status = .consumed
        entries[placeId] = entry
      } else if entry.status == .consumed && isPending {
        let intent = PersistedCancellationIntent(
          placeId: placeId,
          installationId: entry.installationId
        )
        addCancellationIntent(
          placeId: intent.placeId,
          installationId: intent.installationId,
          state: &state
        )
        state.requests = sortedManifest(entries)
        try saveState(&state)
        _ = try await executeCancellation(intent, state: &state)
      }
    }

    state.requests = sortedManifest(entries)
    try saveState(&state)

    let knownInstallationIds = Set(
      entries.values.map(\.installationId) +
        state.pendingCancellations.map(\.installationId)
    )
    let orphanIds = pendingRequests
      .map(\.identifier)
      .filter {
        isManagedIdentifier($0) && !knownInstallationIds.contains($0)
      }
    for orphanId in uniqueSorted(orphanIds) {
      let intent = PersistedCancellationIntent(
        placeId: "",
        installationId: orphanId
      )
      addCancellationIntent(
        placeId: intent.placeId,
        installationId: intent.installationId,
        state: &state
      )
      try saveState(&state)
      _ = try await executeCancellation(intent, state: &state)
    }

    pendingRequests = await notificationCenter.pendingNotificationRequests()
    state.requests = sortedManifest(entries)
    return makeStateView(state: state, pendingRequests: pendingRequests)
  }

  private func acquireOperation() async {
    if !operationInProgress {
      operationInProgress = true
      return
    }

    await withCheckedContinuation { continuation in
      operationWaiters.append(continuation)
    }
  }

  private func releaseOperation() {
    guard !operationWaiters.isEmpty else {
      operationInProgress = false
      return
    }
    operationWaiters.removeFirst().resume()
  }

  private func validateSnapshotFreshness(
    _ snapshot: PersistedCandidateSnapshot,
    previous: PersistedCandidateSnapshot?
  ) throws {
    guard let previous else {
      return
    }
    guard
      let generatedAt = CandidateSnapshotValidator.iso8601Date(snapshot.generatedAt),
      let previousGeneratedAt = CandidateSnapshotValidator.iso8601Date(
        previous.generatedAt
      )
    else {
      throw CandidateSnapshotValidationError.invalid(
        "generatedAt must be a canonical ISO-8601 UTC timestamp."
      )
    }

    if generatedAt < previousGeneratedAt {
      throw CandidateSnapshotValidationError.invalid(
        "generatedAt is older than the persisted snapshot."
      )
    }
    if generatedAt == previousGeneratedAt && snapshot != previous {
      throw CandidateSnapshotValidationError.invalid(
        "generatedAt conflicts with the persisted snapshot."
      )
    }
  }

  private func itemReferencesRemainEligible(
    _ references: [PersistedItemReference],
    itemsById: [String: Int]
  ) -> Bool {
    references.allSatisfy { reference in
      itemsById[reference.id] == reference.revision
    }
  }

  private func desiredNotifications(
    from snapshot: PersistedCandidateSnapshot
  ) throws -> [DesiredStoreNotification] {
    let itemsById = Dictionary(
      uniqueKeysWithValues: snapshot.items.map { ($0.id, $0) }
    )
    let anchorLocation = CLLocation(
      latitude: snapshot.discoveryAnchor.latitude,
      longitude: snapshot.discoveryAnchor.longitude
    )

    let ranked: [DesiredStoreNotification] =
      try collapseDuplicateStores(snapshot.stores).compactMap {
        (store: PersistedCandidateStore) -> DesiredStoreNotification? in
      let items = store.itemIds.compactMap { itemsById[$0] }.sorted {
        $0.id < $1.id
      }
      guard !items.isEmpty else {
        return nil
      }

      let itemReferences = items.map {
        PersistedItemReference(id: $0.id, revision: $0.revision)
      }
      let itemIds = itemReferences.map(\.id)
      let itemRevisions = Dictionary(
        uniqueKeysWithValues: itemReferences.map { ($0.id, $0.revision) }
      )
      let storeLocation = CLLocation(
        latitude: store.location.latitude,
        longitude: store.location.longitude
      )
      let title = concise("At \(store.name)", maximumLength: 100)
      let body = notificationBody(items: items)
      let fingerprint = try requestFingerprint(
        placeId: store.placeId,
        name: store.name,
        location: store.location,
        items: items
      )

      return DesiredStoreNotification(
        placeId: store.placeId,
        name: store.name,
        location: store.location,
        distanceMeters: anchorLocation.distance(from: storeLocation),
        itemReferences: itemReferences,
        itemIds: itemIds,
        itemRevisions: itemRevisions,
        title: title,
        body: body,
        fingerprint: fingerprint,
        snapshotGeneratedAt: snapshot.generatedAt
      )
    }.sorted {
      (left: DesiredStoreNotification, right: DesiredStoreNotification) in
      if left.distanceMeters != right.distanceMeters {
        return left.distanceMeters < right.distanceMeters
      }
      return left.placeId < right.placeId
    }

    var remaining = ranked
    var selected: [DesiredStoreNotification] = []
    var uncoveredItemIds: Set<String> = Set(
      ranked.flatMap { store in store.itemIds }
    )

    while
      selected.count < GeofenceNotificationConstants.maximumSelectedStores,
      !uncoveredItemIds.isEmpty
    {
      var bestIndex: Int?
      var bestCoverage = 0

      for (index, store) in remaining.enumerated() {
        let coverage = store.itemIds.reduce(into: 0) { count, itemId in
          if uncoveredItemIds.contains(itemId) {
            count += 1
          }
        }
        if coverage > bestCoverage {
          bestIndex = index
          bestCoverage = coverage
        }
      }

      guard let bestIndex else {
        break
      }

      let store = remaining.remove(at: bestIndex)
      selected.append(store)
      uncoveredItemIds.subtract(store.itemIds)
    }

    selected.append(
      contentsOf: remaining.prefix(
        GeofenceNotificationConstants.maximumSelectedStores - selected.count
      )
    )
    selected.sort { left, right in
      if left.distanceMeters != right.distanceMeters {
        return left.distanceMeters < right.distanceMeters
      }
      return left.placeId < right.placeId
    }
    let selectedPlaceIds = Set(selected.map(\.placeId))

    return selected + ranked.filter {
      !selectedPlaceIds.contains($0.placeId)
    }
  }

  private func collapseDuplicateStores(
    _ stores: [PersistedCandidateStore]
  ) -> [PersistedCandidateStore] {
    let orderedStores = stores.sorted(by: representativeStorePrecedes)
    var collapsed: [PersistedCandidateStore] = []

    for store in orderedStores {
      let identity = normalizedBusinessIdentity(store.name)
      guard
        !identity.isEmpty,
        let duplicateIndex = collapsed.firstIndex(where: { candidate in
          normalizedBusinessIdentity(candidate.name) == identity &&
            distanceBetween(candidate.location, store.location) <=
              GeofenceNotificationConstants.duplicateStoreDistanceMeters
        })
      else {
        collapsed.append(store)
        continue
      }

      let representative = collapsed[duplicateIndex]
      collapsed[duplicateIndex] = PersistedCandidateStore(
        placeId: representative.placeId,
        name: representative.name,
        location: representative.location,
        itemIds: Array(Set(representative.itemIds + store.itemIds)).sorted()
      )
    }

    return collapsed
  }

  private func representativeStorePrecedes(
    _ left: PersistedCandidateStore,
    _ right: PersistedCandidateStore
  ) -> Bool {
    let leftName = left.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let rightName = right.name.trimmingCharacters(in: .whitespacesAndNewlines)
    if leftName.count != rightName.count {
      return leftName.count < rightName.count
    }
    return left.placeId < right.placeId
  }

  private func normalizedBusinessIdentity(_ name: String) -> String {
    let folded = name.folding(
      options: [.caseInsensitive, .diacriticInsensitive],
      locale: Locale(identifier: "en_US_POSIX")
    )
    let withoutApostrophes = folded
      .replacingOccurrences(of: "'", with: "")
      .replacingOccurrences(of: "’", with: "")
    var tokens = withoutApostrophes
      .components(separatedBy: CharacterSet.alphanumerics.inverted)
      .filter { !$0.isEmpty }
    if let last = tokens.last, last == "pharmacy" || last == "drugstore" {
      tokens.removeLast()
    }
    return tokens.joined(separator: " ")
  }

  private func distanceBetween(
    _ left: PersistedCoordinate,
    _ right: PersistedCoordinate
  ) -> CLLocationDistance {
    CLLocation(latitude: left.latitude, longitude: left.longitude).distance(
      from: CLLocation(latitude: right.latitude, longitude: right.longitude)
    )
  }

  private func requestFingerprint(
    placeId: String,
    name: String,
    location: PersistedCoordinate,
    items: [PersistedCandidateItem]
  ) throws -> String {
    struct FingerprintItem: Encodable {
      let id: String
      let revision: Int
      let text: String
    }

    struct FingerprintInput: Encodable {
      let placeId: String
      let name: String
      let latitude: Double
      let longitude: Double
      let radiusMeters: Double
      let items: [FingerprintItem]
    }

    let data = try encoder.encode(
      FingerprintInput(
        placeId: placeId,
        name: name,
        latitude: location.latitude,
        longitude: location.longitude,
        radiusMeters: GeofenceNotificationConstants.radiusMeters,
        items: items.map {
          FingerprintItem(id: $0.id, revision: $0.revision, text: $0.text)
        }
      )
    )
    return SHA256.hash(data: data).map {
      String(format: "%02x", $0)
    }.joined()
  }

  private func makeNotificationRequest(
    installationId: String,
    desired: DesiredStoreNotification
  ) -> UNNotificationRequest {
    let region = CLCircularRegion(
      center: CLLocationCoordinate2D(
        latitude: desired.location.latitude,
        longitude: desired.location.longitude
      ),
      radius: GeofenceNotificationConstants.radiusMeters,
      identifier: installationId
    )
    region.notifyOnEntry = true
    region.notifyOnExit = false

    let content = UNMutableNotificationContent()
    content.title = desired.title
    content.body = desired.body
    content.sound = .default
    content.threadIdentifier = semanticPlaceHash(desired.placeId)
    content.userInfo = [
      "schemaVersion": GeofenceNotificationConstants.candidateSchemaVersion,
      "placeId": desired.placeId,
      "itemIds": desired.itemIds,
      "itemRevisions": desired.itemRevisions,
      "requestFingerprint": desired.fingerprint,
      "snapshotGeneratedAt": desired.snapshotGeneratedAt
    ]

    return UNNotificationRequest(
      identifier: installationId,
      content: content,
      trigger: UNLocationNotificationTrigger(region: region, repeats: false)
    )
  }

  private func verify(
    request: UNNotificationRequest,
    matches desired: DesiredStoreNotification
  ) -> Bool {
    guard
      let trigger = request.trigger as? UNLocationNotificationTrigger,
      let region = trigger.region as? CLCircularRegion,
      request.content.title == desired.title,
      request.content.body == desired.body,
      request.content.userInfo["placeId"] as? String == desired.placeId,
      request.content.userInfo["requestFingerprint"] as? String == desired.fingerprint,
      request.content.userInfo["itemIds"] as? [String] == desired.itemIds,
      parseRevisions(request.content.userInfo["itemRevisions"]) == desired.itemRevisions,
      abs(region.center.latitude - desired.location.latitude) < 0.000_001,
      abs(region.center.longitude - desired.location.longitude) < 0.000_001,
      abs(region.radius - GeofenceNotificationConstants.radiusMeters) < 0.01,
      region.notifyOnEntry,
      !region.notifyOnExit,
      !trigger.repeats
    else {
      return false
    }
    return true
  }

  private func parseRevisions(_ value: Any?) -> [String: Int]? {
    if let revisions = value as? [String: Int] {
      return revisions
    }
    guard let revisions = value as? [String: Any] else {
      return nil
    }

    var result: [String: Int] = [:]
    for (key, value) in revisions {
      if let number = value as? NSNumber {
        result[key] = number.intValue
      } else if let revision = value as? Int {
        result[key] = revision
      } else {
        return nil
      }
    }
    return result
  }

  private func retirementCandidate(
    entries: [String: PersistedRequestManifestEntry],
    selectedPlaceIds: Set<String>,
    desiredByPlaceId: [String: DesiredStoreNotification],
    pendingRequests: [UNNotificationRequest]
  ) -> PersistedRequestManifestEntry? {
    entries.values
      .filter { entry in
        entry.status == .pending &&
          !selectedPlaceIds.contains(entry.placeId) &&
          desiredByPlaceId[entry.placeId] != nil &&
          pendingRequests.contains(where: {
            $0.identifier == entry.installationId
          })
      }
      .sorted { left, right in
        let leftDistance = desiredByPlaceId[left.placeId]?.distanceMeters ?? 0
        let rightDistance = desiredByPlaceId[right.placeId]?.distanceMeters ?? 0
        if leftDistance != rightDistance {
          return leftDistance > rightDistance
        }
        return left.placeId > right.placeId
      }
      .first
  }

  private func isSatisfied(
    desired: DesiredStoreNotification,
    entry: PersistedRequestManifestEntry?,
    pendingRequests: [UNNotificationRequest]
  ) -> Bool {
    guard let entry, entry.fingerprint == desired.fingerprint else {
      return false
    }
    if entry.status == .consumed {
      return true
    }
    guard let request = pendingRequests.first(where: {
      $0.identifier == entry.installationId
    }) else {
      return false
    }
    return verify(request: request, matches: desired)
  }

  private func cancelAndVerify(
    identifiers: [String]
  ) async -> (removed: [String], failed: [String]) {
    let managedIds = uniqueSorted(
      identifiers.filter(isManagedIdentifier)
    )
    guard !managedIds.isEmpty else {
      return ([], [])
    }

    notificationCenter.removePendingNotificationRequests(
      withIdentifiers: managedIds
    )
    notificationCenter.removeDeliveredNotifications(
      withIdentifiers: managedIds
    )
    let remainingIds = Set(
      await notificationCenter.pendingNotificationRequests().map(\.identifier)
    )
    let failed = managedIds.filter(remainingIds.contains)
    return (
      managedIds.filter { !remainingIds.contains($0) },
      failed
    )
  }

  private func addCancellationIntent(
    placeId: String,
    installationId: String,
    state: inout PersistedGeofenceState
  ) {
    guard !state.pendingCancellations.contains(where: {
      $0.installationId == installationId
    }) else {
      return
    }
    state.pendingCancellations.append(
      PersistedCancellationIntent(
        placeId: placeId,
        installationId: installationId
      )
    )
    state.pendingCancellations.sort {
      if $0.placeId != $1.placeId {
        return $0.placeId < $1.placeId
      }
      return $0.installationId < $1.installationId
    }
  }

  private func recoverPendingCancellations(
    state: inout PersistedGeofenceState
  ) async throws -> [PersistedCancellationIntent] {
    guard !state.pendingCancellations.isEmpty else {
      return []
    }

    var failed: [PersistedCancellationIntent] = []
    for intent in state.pendingCancellations {
      let cancellation = await cancelAndVerify(
        identifiers: [intent.installationId]
      )
      if !cancellation.failed.isEmpty {
        failed.append(intent)
      }
    }

    if failed != state.pendingCancellations {
      state.pendingCancellations = failed
      try saveState(&state)
    }
    return failed
  }

  private func executeCancellation(
    _ intent: PersistedCancellationIntent,
    state: inout PersistedGeofenceState
  ) async throws -> Bool {
    let cancellation = await cancelAndVerify(
      identifiers: [intent.installationId]
    )
    guard cancellation.failed.isEmpty else {
      return false
    }

    state.pendingCancellations.removeAll {
      $0.installationId == intent.installationId
    }
    try saveState(&state)
    return true
  }

  private func makeStateView(
    state: PersistedGeofenceState,
    pendingRequests: [UNNotificationRequest]
  ) -> NativeGeofenceStateView {
    let pendingIds = Set(pendingRequests.map(\.identifier))
    let requests = state.requests.map { entry in
      NativeRequestView(
        placeId: entry.placeId,
        installationId: entry.installationId,
        fingerprint: entry.fingerprint,
        status: entry.status,
        itemReferences: entry.itemReferences,
        isPending: pendingIds.contains(entry.installationId)
      )
    }
    let desired = state.snapshot.flatMap { snapshot in
      try? desiredNotifications(from: snapshot)
    } ?? []
    let selectedPlaceIds = Array(
      desired.prefix(GeofenceNotificationConstants.maximumSelectedStores)
    ).map(\.placeId)
    let desiredByPlaceId = Dictionary(
      uniqueKeysWithValues: desired.map { ($0.placeId, $0) }
    )
    let requestsByPlaceId = Dictionary(
      uniqueKeysWithValues: requests.map { ($0.placeId, $0) }
    )
    let selectedIsDegraded = selectedPlaceIds.contains { placeId in
      guard let request = requestsByPlaceId[placeId] else {
        return true
      }
      if request.status == .consumed {
        return request.isPending
      }
      if !request.isPending {
        return true
      }
      return request.fingerprint != desiredByPlaceId[placeId]?.fingerprint
    }
    let isDegraded =
      selectedIsDegraded ||
      !state.pendingCancellations.isEmpty

    return NativeGeofenceStateView(
      snapshot: state.snapshot,
      requests: requests,
      selectedPlaceIds: selectedPlaceIds,
      pendingManagedRequestIds: pendingRequests
        .map(\.identifier)
        .filter(isManagedIdentifier)
        .sorted(),
      isDegraded: isDegraded
    )
  }

  private func manifestByPlaceId(
    _ entries: [PersistedRequestManifestEntry]
  ) throws -> [String: PersistedRequestManifestEntry] {
    var result: [String: PersistedRequestManifestEntry] = [:]
    for entry in entries {
      guard isManagedIdentifier(entry.installationId) else {
        throw PersistedGeofenceStateError.unmanagedIdentifier
      }
      guard result[entry.placeId] == nil else {
        throw PersistedGeofenceStateError.duplicatePlaceId
      }
      result[entry.placeId] = entry
    }
    return result
  }

  private func sortedManifest(
    _ entries: [String: PersistedRequestManifestEntry]
  ) -> [PersistedRequestManifestEntry] {
    entries.values.sorted { $0.placeId < $1.placeId }
  }

  private func loadState() throws -> PersistedGeofenceState {
    guard
      let data = UserDefaults.standard.data(
        forKey: GeofenceNotificationConstants.userDefaultsKey
      )
    else {
      return .empty
    }

    do {
      struct SchemaEnvelope: Decodable {
        let schemaVersion: Int
      }

      let envelope = try decoder.decode(SchemaEnvelope.self, from: data)
      var state: PersistedGeofenceState
      let migrated: Bool
      switch envelope.schemaVersion {
      case GeofenceNotificationConstants.stateSchemaVersion:
        state = try decoder.decode(PersistedGeofenceState.self, from: data)
        migrated = false
      case GeofenceNotificationConstants.previousStateSchemaVersion:
        let previous = try decoder.decode(PersistedGeofenceStateV1.self, from: data)
        state = PersistedGeofenceState(
          schemaVersion: GeofenceNotificationConstants.stateSchemaVersion,
          snapshot: previous.snapshot,
          requests: previous.requests,
          pendingCancellations: previous.pendingCancellations,
          observations: [],
          deliveryIntents: []
        )
        migrated = true
      default:
        throw PersistedGeofenceStateError.unsupportedVersion
      }
      _ = try manifestByPlaceId(state.requests)
      try validateCancellationIntents(state.pendingCancellations)
      let previousObservations = state.observations
      let previousDeliveryIntents = state.deliveryIntents
      state = try sanitizedStateForPersistence(state)
      try SmartArrivalStateTransitions.validate(state)
      let repairedTransientState =
        previousObservations != state.observations ||
        previousDeliveryIntents != state.deliveryIntents
      if migrated || repairedTransientState {
        try saveState(&state)
      }
      return state
    } catch {
      UserDefaults.standard.set(
        data,
        forKey: GeofenceNotificationConstants.quarantinedUserDefaultsKey
      )
      UserDefaults.standard.removeObject(
        forKey: GeofenceNotificationConstants.userDefaultsKey
      )
      return .empty
    }
  }

  private func validateCancellationIntents(
    _ intents: [PersistedCancellationIntent]
  ) throws {
    var identifiers = Set<String>()
    for intent in intents {
      guard isManagedIdentifier(intent.installationId) else {
        throw PersistedGeofenceStateError.unmanagedIdentifier
      }
      guard identifiers.insert(intent.installationId).inserted else {
        throw PersistedGeofenceStateError.duplicatePlaceId
      }
    }
  }

  private func saveState(_ state: inout PersistedGeofenceState) throws {
    state = try sanitizedStateForPersistence(state)
    try SmartArrivalStateTransitions.validate(state)
    let data = try encoder.encode(state)
    UserDefaults.standard.set(
      data,
      forKey: GeofenceNotificationConstants.userDefaultsKey
    )
  }

  private func sanitizedStateForPersistence(
    _ state: PersistedGeofenceState
  ) throws -> PersistedGeofenceState {
    let desiredFingerprintsByPlaceId: [String: String]
    if let snapshot = state.snapshot {
      desiredFingerprintsByPlaceId = Dictionary(
        uniqueKeysWithValues: try desiredNotifications(from: snapshot).map {
          ($0.placeId, $0.fingerprint)
        }
      )
    } else {
      desiredFingerprintsByPlaceId = [:]
    }
    return SmartArrivalStateTransitions.sanitizedForPersistence(
      state,
      desiredFingerprintsByPlaceId: desiredFingerprintsByPlaceId
    )
  }

  private func makeInstallationId(placeId: String) -> String {
    [
      GeofenceNotificationConstants.managedIdentifierPrefix,
      semanticPlaceHash(placeId),
      ".",
      UUID().uuidString.lowercased()
    ].joined()
  }

  private func semanticPlaceHash(_ placeId: String) -> String {
    let digest = SHA256.hash(data: Data(placeId.utf8))
    return digest.prefix(8).map {
      String(format: "%02x", $0)
    }.joined()
  }

  private func isManagedIdentifier(_ identifier: String) -> Bool {
    identifier.hasPrefix(GeofenceNotificationConstants.managedIdentifierPrefix)
  }

  private func notificationBody(items: [PersistedCandidateItem]) -> String {
    let names = items.map {
      concise(
        normalizedWhitespace($0.text),
        maximumLength: GeofenceNotificationConstants.maximumDisplayedItemLength
      )
    }
    let namedLimit = GeofenceNotificationConstants.maximumNamedItemsInBody
    let joined: String
    if names.count <= namedLimit {
      joined = names.joined(separator: " • ")
    } else {
      joined =
        names.prefix(namedLimit).joined(separator: " • ") +
        " • +\(names.count - namedLimit) more"
    }
    return concise(
      joined,
      maximumLength: GeofenceNotificationConstants.maximumNotificationBodyLength
    )
  }

  private func normalizedWhitespace(_ value: String) -> String {
    value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  private func concise(_ value: String, maximumLength: Int) -> String {
    guard value.count > maximumLength else {
      return value
    }
    return String(value.prefix(maximumLength - 1)) + "…"
  }

  private func uniqueSorted(_ values: [String]) -> [String] {
    Array(Set(values)).sorted()
  }
}
