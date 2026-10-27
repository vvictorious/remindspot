import CoreLocation
import Foundation

// Decision contract for background discovery. Keep this file free of UIKit so
// debug validation can execute the same functions outside the app. Constants
// match src/native/background-discovery.ts. Distance uses CLLocation.

enum BackgroundDiscoveryPolicy {
  static let schemaVersion = 1
  static let reuseDistanceMeters = 1_000.0
  static let failureCooldownSeconds = 15.0 * 60
  static let requestTimeoutSeconds = 10.0
  static let abandonedInFlightSeconds = 2.0 * 60
  static let storeRadiusMeters = 100.0
  static let maximumVisitAccuracyMeters = 100.0
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
    "home-goods-store",
  ]

  struct Item: Equatable {
    var id: String
    var revision: Int
    var text: String
    var taxonomyVersion: Int
    var categories: [String]
  }

  struct Attempt: Equatable {
    var inFlightStartedAt: Date?
    var inFlightLatitude: Double?
    var inFlightLongitude: Double?
    var inFlightItemSignature: String?
    var lastArrivalKey: String?
    var lastFailureAt: Date?
    var lastFailureLatitude: Double?
    var lastFailureLongitude: Double?
    var lastFailureItemSignature: String?

    static let empty = Attempt(
      inFlightStartedAt: nil,
      inFlightLatitude: nil,
      inFlightLongitude: nil,
      inFlightItemSignature: nil,
      lastArrivalKey: nil,
      lastFailureAt: nil,
      lastFailureLatitude: nil,
      lastFailureLongitude: nil,
      lastFailureItemSignature: nil
    )
  }

  struct Anchor: Equatable {
    var itemSignature: String
    var latitude: Double
    var longitude: Double
  }

  struct DecisionInput {
    var now: Date
    var appState: String
    var allowForeground: Bool
    var authorization: String
    var arrivalKnown: Bool
    var departed: Bool
    var coordinateValid: Bool
    var latitude: Double
    var longitude: Double
    var arrivalKey: String
    var items: [Item]
    var apiBaseUrl: String?
    var attempt: Attempt
    var anchor: Anchor?
  }

  enum Decision: Equatable {
    case search
    case skip(String)
  }

  struct DecodedStore: Equatable {
    var placeId: String
    var name: String
    var latitude: Double
    var longitude: Double
    var itemIds: [String]
  }

  struct ParsedBody: Equatable {
    var outcome: String
    var stores: [DecodedStore]
  }

  struct PersistedSnapshot: Equatable {
    var generatedAt: Date
    var itemSignature: String
    var latitude: Double
    var longitude: Double
  }

  struct NearbyStore: Equatable {
    var placeId: String
    var latitude: Double
    var longitude: Double
    var selected: Bool
    var pending: Bool
    var newlyScheduled: Bool
  }

  struct CommitPlan: Equatable {
    var reconcile: Bool
    var observe: Bool
    var rollBack: Bool
  }

  static func itemSignature(_ items: [Item]) -> String {
    let encoded = canonicalItems(items).map { item in
      let categories = item.categories.map(jsonString).joined(separator: ",")
      return "{\"id\":\(jsonString(item.id)),\"revision\":\(item.revision),\"text\":\(jsonString(item.text)),\"taxonomyVersion\":\(item.taxonomyVersion),\"categories\":[\(categories)]}"
    }
    return "[\(encoded.joined(separator: ","))]"
  }

  static func placeItemsSignature(_ items: [Item]) -> String {
    let encoded = canonicalItems(items).map { item in
      let categories = item.categories.map(jsonString).joined(separator: ",")
      return "{\"id\":\(jsonString(item.id)),\"revision\":\(item.revision),\"taxonomyVersion\":\(item.taxonomyVersion),\"categories\":[\(categories)]}"
    }
    return "[\(encoded.joined(separator: ","))]"
  }

  static func decide(_ input: DecisionInput) -> Decision {
    let isArrival = input.arrivalKnown && !input.departed
    if !isArrival {
      return .skip("not-arrival")
    }
    if input.appState == "active" && !input.allowForeground {
      return .skip("app-active")
    }
    if input.authorization != "always-precise" {
      return .skip("authorization")
    }
    if !input.coordinateValid || !input.latitude.isFinite || !input.longitude.isFinite {
      return .skip("invalid-coordinate")
    }
    if input.items.isEmpty {
      return .skip("empty-items")
    }
    if input.apiBaseUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
      return .skip("missing-api-url")
    }
    if input.attempt.lastArrivalKey == input.arrivalKey {
      return .skip("duplicate-arrival")
    }
    if let startedAt = input.attempt.inFlightStartedAt {
      let age = input.now.timeIntervalSince(startedAt)
      if age >= 0 && age < abandonedInFlightSeconds {
        return .skip("in-flight")
      }
    }

    let currentSignature = itemSignature(input.items)
    if let anchor = input.anchor,
      anchor.itemSignature == currentSignature,
      distanceMeters(
        latitude: input.latitude,
        longitude: input.longitude,
        otherLatitude: anchor.latitude,
        otherLongitude: anchor.longitude
      ) < reuseDistanceMeters
    {
      return .skip("unchanged-nearby-anchor")
    }

    if let failure = effectiveFailure(input.attempt, now: input.now),
      failure.itemSignature == currentSignature
    {
      let age = input.now.timeIntervalSince(failure.at)
      let distance = distanceMeters(
        latitude: input.latitude,
        longitude: input.longitude,
        otherLatitude: failure.latitude,
        otherLongitude: failure.longitude
      )
      if age >= 0,
        age < failureCooldownSeconds,
        distance < reuseDistanceMeters
      {
        return .skip("failure-cooldown")
      }
    }

    return .search
  }

  static func parseBody(_ data: Data) -> ParsedBody {
    guard
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let status = json["status"] as? String,
      let storeValues = json["stores"] as? [Any],
      let failureValues = json["categoryFailures"] as? [Any]
    else {
      return ParsedBody(outcome: "invalid", stores: [])
    }

    let knownCategories = Set(categoryOrder)
    var failures: [(category: String, code: String)] = []
    for value in failureValues {
      guard
        let failure = value as? [String: Any],
        let category = failure["category"] as? String,
        knownCategories.contains(category),
        failure["code"] as? String == "provider-error"
      else {
        return ParsedBody(outcome: "invalid", stores: [])
      }
      failures.append((category, "provider-error"))
    }

    let consistent =
      (status == "complete" && failures.isEmpty) ||
      (status != "complete" && !failures.isEmpty)
    guard status == "complete" || status == "partial" || status == "failed",
      consistent
    else {
      return ParsedBody(outcome: "invalid", stores: [])
    }

    var stores: [DecodedStore] = []
    for value in storeValues {
      guard let store = decodeStore(value) else {
        return ParsedBody(outcome: "invalid", stores: [])
      }
      stores.append(store)
    }
    return ParsedBody(outcome: status, stores: stores)
  }

  static func classifyResponse(
    cancelled: Bool,
    expired: Bool,
    timedOut: Bool,
    networkError: Bool,
    httpStatus: Int?,
    parsedOutcome: String?
  ) -> String {
    if expired {
      return "expired"
    }
    if cancelled {
      return "cancelled"
    }
    if timedOut {
      return "timeout"
    }
    if networkError || httpStatus == nil {
      return "network"
    }
    if httpStatus != 200 {
      return "http"
    }
    guard let parsedOutcome else {
      return "invalid"
    }
    return parsedOutcome
  }

  static func shouldApply(_ outcome: String) -> Bool {
    outcome == "complete"
  }

  static func shouldCommitDiscoveredItems(
    requestItemSignature: String,
    currentItems: [Item]
  ) -> Bool {
    itemSignature(currentItems) == requestItemSignature
  }

  static func shouldRecordFailureCooldown(after outcome: String) -> Bool {
    outcome != "input-changed"
  }

  static func shouldDiscard(
    requestStartedAt: Date,
    requestItemSignature: String,
    visitLatitude: Double,
    visitLongitude: Double,
    persisted: PersistedSnapshot?
  ) -> Bool {
    guard let persisted else {
      return false
    }
    if persisted.generatedAt <= requestStartedAt {
      return false
    }
    let signatureDiffers = persisted.itemSignature != requestItemSignature
    let anchorNearby =
      distanceMeters(
        latitude: visitLatitude,
        longitude: visitLongitude,
        otherLatitude: persisted.latitude,
        otherLongitude: persisted.longitude
      ) < reuseDistanceMeters
    return signatureDiffers || anchorNearby
  }

  static func nextGeneratedAt(now: Date, previous: Date?) -> Date {
    let nowMilliseconds = (now.timeIntervalSince1970 * 1_000).rounded()
    let previousMilliseconds =
      previous.map { ($0.timeIntervalSince1970 * 1_000).rounded() }
      ?? -Double.greatestFiniteMagnitude
    let nextMilliseconds = max(nowMilliseconds, previousMilliseconds + 1)
    return Date(timeIntervalSince1970: nextMilliseconds / 1_000)
  }

  static func alreadyNearby(
    visitAccuracyMeters: Double,
    visitLatitude: Double,
    visitLongitude: Double,
    stores: [NearbyStore]
  ) -> [String] {
    guard
      visitAccuracyMeters.isFinite,
      visitAccuracyMeters >= 0,
      visitAccuracyMeters <= maximumVisitAccuracyMeters
    else {
      return []
    }
    let limit = storeRadiusMeters + visitAccuracyMeters
    return stores.compactMap { store in
      guard store.selected, store.pending, store.newlyScheduled else {
        return nil
      }
      let distance = distanceMeters(
        latitude: visitLatitude,
        longitude: visitLongitude,
        otherLatitude: store.latitude,
        otherLongitude: store.longitude
      )
      return distance <= limit ? store.placeId : nil
    }
  }

  static func commitPlan(
    expiredOrCancelledBeforeReconcile: Bool,
    expiredOrCancelledAfterReconcile: Bool
  ) -> CommitPlan {
    if expiredOrCancelledBeforeReconcile {
      return CommitPlan(reconcile: false, observe: false, rollBack: false)
    }
    if expiredOrCancelledAfterReconcile {
      return CommitPlan(reconcile: true, observe: false, rollBack: false)
    }
    return CommitPlan(reconcile: true, observe: true, rollBack: false)
  }

  static func distanceMeters(
    latitude: Double,
    longitude: Double,
    otherLatitude: Double,
    otherLongitude: Double
  ) -> Double {
    CLLocation(latitude: latitude, longitude: longitude).distance(
      from: CLLocation(latitude: otherLatitude, longitude: otherLongitude)
    )
  }

  private struct Failure {
    var at: Date
    var latitude: Double
    var longitude: Double
    var itemSignature: String
  }

  private static func effectiveFailure(
    _ attempt: Attempt,
    now: Date
  ) -> Failure? {
    if let startedAt = attempt.inFlightStartedAt {
      let age = now.timeIntervalSince(startedAt)
      if age >= abandonedInFlightSeconds {
        guard
          let latitude = attempt.inFlightLatitude,
          let longitude = attempt.inFlightLongitude,
          let signature = attempt.inFlightItemSignature
        else {
          return nil
        }
        return Failure(
          at: startedAt,
          latitude: latitude,
          longitude: longitude,
          itemSignature: signature
        )
      }
    }

    guard
      let failedAt = attempt.lastFailureAt,
      let latitude = attempt.lastFailureLatitude,
      let longitude = attempt.lastFailureLongitude,
      let signature = attempt.lastFailureItemSignature
    else {
      return nil
    }
    return Failure(
      at: failedAt,
      latitude: latitude,
      longitude: longitude,
      itemSignature: signature
    )
  }

  private static func canonicalItems(_ items: [Item]) -> [Item] {
    let order = Dictionary(
      uniqueKeysWithValues: categoryOrder.enumerated().map { ($1, $0) }
    )
    return items.map { item in
      var copy = item
      copy.categories.sort {
        (order[$0] ?? Int.max) < (order[$1] ?? Int.max)
      }
      return copy
    }
    .sorted { $0.id < $1.id }
  }

  private static func decodeStore(_ value: Any) -> DecodedStore? {
    guard
      let store = value as? [String: Any],
      let placeId = store["placeId"] as? String,
      !placeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let name = store["name"] as? String,
      !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let location = store["location"] as? [String: Any],
      let latitude = jsonDouble(location["latitude"]),
      let longitude = jsonDouble(location["longitude"]),
      CLLocationCoordinate2DIsValid(
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
      ),
      let itemIds = store["itemIds"] as? [String],
      !itemIds.isEmpty,
      itemIds.allSatisfy({ itemId in
        !itemId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      }),
      Set(itemIds).count == itemIds.count
    else {
      return nil
    }
    return DecodedStore(
      placeId: placeId,
      name: name,
      latitude: latitude,
      longitude: longitude,
      itemIds: itemIds
    )
  }

  private static func jsonDouble(_ value: Any?) -> Double? {
    if let number = value as? Double {
      return number.isFinite ? number : nil
    }
    if let number = value as? NSNumber {
      let double = number.doubleValue
      return double.isFinite ? double : nil
    }
    return nil
  }

  private static func jsonString(_ value: String) -> String {
    var encoded = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x22:
        encoded += "\\\""
      case 0x5C:
        encoded += "\\\\"
      case 0x08:
        encoded += "\\b"
      case 0x0C:
        encoded += "\\f"
      case 0x0A:
        encoded += "\\n"
      case 0x0D:
        encoded += "\\r"
      case 0x09:
        encoded += "\\t"
      default:
        if scalar.value < 0x20 {
          encoded += String(format: "\\u%04x", scalar.value)
        } else {
          encoded.append(String(scalar))
        }
      }
    }
    encoded += "\""
    return encoded
  }
}

#if DEBUG
enum BackgroundDiscoveryPolicyValidation {
  static func failures() -> [String] {
    var failures: [String] = []
    func expect(_ condition: Bool, _ message: String) {
      if !condition {
        failures.append(message)
      }
    }

    let milk = BackgroundDiscoveryPolicy.Item(
      id: "milk",
      revision: 1,
      text: "Milk",
      taxonomyVersion: 1,
      categories: ["grocery-store"]
    )
    let film = BackgroundDiscoveryPolicy.Item(
      id: "film",
      revision: 2,
      text: "Photo paper",
      taxonomyVersion: 1,
      categories: ["department-store", "electronics-store"]
    )
    expect(
      BackgroundDiscoveryPolicy.itemSignature([milk, film]) ==
        "[{\"id\":\"film\",\"revision\":2,\"text\":\"Photo paper\",\"taxonomyVersion\":1,\"categories\":[\"electronics-store\",\"department-store\"]},{\"id\":\"milk\",\"revision\":1,\"text\":\"Milk\",\"taxonomyVersion\":1,\"categories\":[\"grocery-store\"]}]",
      "item signature drifted from the TypeScript contract"
    )
    expect(
      BackgroundDiscoveryPolicy.placeItemsSignature([film, milk]) ==
        "[{\"id\":\"film\",\"revision\":2,\"taxonomyVersion\":1,\"categories\":[\"electronics-store\",\"department-store\"]},{\"id\":\"milk\",\"revision\":1,\"taxonomyVersion\":1,\"categories\":[\"grocery-store\"]}]",
      "place signature drifted from the TypeScript contract"
    )
    let quoted = BackgroundDiscoveryPolicy.Item(
      id: "q",
      revision: 1,
      text: "Say \"hi\"",
      taxonomyVersion: 1,
      categories: ["grocery-store"]
    )
    expect(
      BackgroundDiscoveryPolicy.itemSignature([quoted]) ==
        "[{\"id\":\"q\",\"revision\":1,\"text\":\"Say \\\"hi\\\"\",\"taxonomyVersion\":1,\"categories\":[\"grocery-store\"]}]",
      "quoted item signature drifted"
    )

    let now = Date(timeIntervalSince1970: 1_761_240_000)
    let originLatitude = 34.02
    let originLongitude = -118.42
    func input(
      _ mutate: (inout BackgroundDiscoveryPolicy.DecisionInput) -> Void = { _ in }
    ) -> BackgroundDiscoveryPolicy.DecisionInput {
      var value = BackgroundDiscoveryPolicy.DecisionInput(
        now: now,
        appState: "background",
        allowForeground: false,
        authorization: "always-precise",
        arrivalKnown: true,
        departed: false,
        coordinateValid: true,
        latitude: originLatitude,
        longitude: originLongitude,
        arrivalKey: "arrival-1",
        items: [milk],
        apiBaseUrl: "http://192.168.1.20:3000",
        attempt: .empty,
        anchor: nil
      )
      mutate(&value)
      return value
    }
    func reason(_ decision: BackgroundDiscoveryPolicy.Decision) -> String {
      switch decision {
      case .search:
        return "search"
      case .skip(let reason):
        return reason
      }
    }

    expect(reason(BackgroundDiscoveryPolicy.decide(input())) == "search", "arrival should search")
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.departed = true })) == "not-arrival",
      "departure should not search"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.arrivalKnown = true
          $0.departed = true
        })
      ) == "not-arrival",
      "combined visit should not search"
    )
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.arrivalKnown = false })) == "not-arrival",
      "unknown arrival should not search"
    )
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.appState = "active" })) == "app-active",
      "foreground visit should skip"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.appState = "active"
          $0.allowForeground = true
        })
      ) == "search",
      "explicit foreground simulation should search"
    )
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.authorization = "unavailable" })) ==
        "authorization",
      "missing Always precise should skip"
    )
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.coordinateValid = false })) ==
        "invalid-coordinate",
      "invalid coordinate should skip"
    )
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.items = [] })) == "empty-items",
      "empty items should skip"
    )
    expect(
      reason(BackgroundDiscoveryPolicy.decide(input { $0.apiBaseUrl = " " })) == "missing-api-url",
      "blank API URL should skip"
    )

    let signature = BackgroundDiscoveryPolicy.itemSignature([milk])
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.attempt.lastArrivalKey = "arrival-1"
        })
      ) == "duplicate-arrival",
      "duplicate arrival should skip"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.arrivalKey = "arrival-2"
          $0.attempt.inFlightStartedAt = now.addingTimeInterval(-30)
          $0.attempt.inFlightLatitude = originLatitude
          $0.attempt.inFlightLongitude = originLongitude
          $0.attempt.inFlightItemSignature = signature
        })
      ) == "in-flight",
      "young in-flight request should skip"
    )

    let nearbyLatitude = originLatitude + 400 / 111_320
    let nearbyDistance = BackgroundDiscoveryPolicy.distanceMeters(
      latitude: originLatitude,
      longitude: originLongitude,
      otherLatitude: nearbyLatitude,
      otherLongitude: originLongitude
    )
    expect(
      nearbyDistance < BackgroundDiscoveryPolicy.reuseDistanceMeters,
      "nearby fixture is not inside the reuse distance"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.latitude = nearbyLatitude
          $0.anchor = BackgroundDiscoveryPolicy.Anchor(
            itemSignature: signature,
            latitude: originLatitude,
            longitude: originLongitude
          )
        })
      ) == "unchanged-nearby-anchor",
      "unchanged nearby anchor should skip"
    )
    let farLatitude = originLatitude + 2_200 / 111_320
    let farDistance = BackgroundDiscoveryPolicy.distanceMeters(
      latitude: originLatitude,
      longitude: originLongitude,
      otherLatitude: farLatitude,
      otherLongitude: originLongitude
    )
    expect(
      farDistance > BackgroundDiscoveryPolicy.reuseDistanceMeters,
      "far fixture is not beyond the reuse distance"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.latitude = farLatitude
          $0.anchor = BackgroundDiscoveryPolicy.Anchor(
            itemSignature: signature,
            latitude: originLatitude,
            longitude: originLongitude
          )
        })
      ) == "search",
      "movement beyond the anchor should search"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.items = [
            BackgroundDiscoveryPolicy.Item(
              id: "milk",
              revision: 2,
              text: "Milk",
              taxonomyVersion: 1,
              categories: ["grocery-store"]
            )
          ]
          $0.anchor = BackgroundDiscoveryPolicy.Anchor(
            itemSignature: signature,
            latitude: originLatitude,
            longitude: originLongitude
          )
        })
      ) == "search",
      "item signature change should search"
    )

    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.attempt.lastFailureAt = now.addingTimeInterval(-60)
          $0.attempt.lastFailureLatitude = originLatitude
          $0.attempt.lastFailureLongitude = originLongitude
          $0.attempt.lastFailureItemSignature = signature
        })
      ) == "failure-cooldown",
      "recent nearby failure should cool down"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.latitude = farLatitude
          $0.attempt.lastFailureAt = now.addingTimeInterval(-60)
          $0.attempt.lastFailureLatitude = originLatitude
          $0.attempt.lastFailureLongitude = originLongitude
          $0.attempt.lastFailureItemSignature = signature
        })
      ) == "search",
      "failure cooldown should not cover a distant visit"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.attempt.inFlightStartedAt = now.addingTimeInterval(-180)
          $0.attempt.inFlightLatitude = originLatitude
          $0.attempt.inFlightLongitude = originLongitude
          $0.attempt.inFlightItemSignature = signature
        })
      ) == "failure-cooldown",
      "abandoned in-flight record should not retry by itself"
    )
    expect(
      reason(
        BackgroundDiscoveryPolicy.decide(input {
          $0.attempt.inFlightStartedAt = now.addingTimeInterval(
            -(BackgroundDiscoveryPolicy.failureCooldownSeconds + 5)
          )
          $0.attempt.inFlightLatitude = originLatitude
          $0.attempt.inFlightLongitude = originLongitude
          $0.attempt.inFlightItemSignature = signature
        })
      ) == "search",
      "abandoned failure older than the cooldown should search"
    )

    let complete = Data(
      #"{"status":"complete","stores":[{"placeId":"market","name":"Market","location":{"latitude":34.02,"longitude":-118.42},"itemIds":["milk"]}],"categoryFailures":[]}"#
        .utf8
    )
    let parsed = BackgroundDiscoveryPolicy.parseBody(complete)
    expect(parsed.outcome == "complete", "complete body should parse")
    expect(parsed.stores.count == 1, "complete body should keep its store")
    expect(
      BackgroundDiscoveryPolicy.shouldApply(
        BackgroundDiscoveryPolicy.classifyResponse(
          cancelled: false,
          expired: false,
          timedOut: false,
          networkError: false,
          httpStatus: 200,
          parsedOutcome: parsed.outcome
        )
      ),
      "complete response should apply"
    )
    expect(
      BackgroundDiscoveryPolicy.parseBody(
        Data(
          #"{"status":"complete","stores":[],"categoryFailures":[{"category":"grocery-store","code":"provider-error"}]}"#
            .utf8
        )
      ).outcome == "invalid",
      "inconsistent complete response should be rejected"
    )
    expect(
      BackgroundDiscoveryPolicy.parseBody(
        Data(
          #"{"status":"partial","stores":[],"categoryFailures":[{"category":"grocery-store","code":"provider-error"}]}"#
            .utf8
        )
      ).outcome == "partial",
      "partial response should parse"
    )
    expect(
      !BackgroundDiscoveryPolicy.shouldApply("partial") &&
        !BackgroundDiscoveryPolicy.shouldApply("failed") &&
        !BackgroundDiscoveryPolicy.shouldApply("timeout") &&
        !BackgroundDiscoveryPolicy.shouldApply("cancelled") &&
        !BackgroundDiscoveryPolicy.shouldApply("expired") &&
        !BackgroundDiscoveryPolicy.shouldApply("invalid"),
      "incomplete outcomes must not apply"
    )
    expect(
      BackgroundDiscoveryPolicy.classifyResponse(
        cancelled: true,
        expired: true,
        timedOut: false,
        networkError: false,
        httpStatus: 200,
        parsedOutcome: "complete"
      ) == "expired",
      "expiration outranks a complete body"
    )
    expect(
      BackgroundDiscoveryPolicy.parseBody(Data("[]".utf8)).outcome == "invalid",
      "malformed body should be rejected"
    )

    let requestStartedAt = now.addingTimeInterval(-5)
    expect(
      !BackgroundDiscoveryPolicy.shouldDiscard(
        requestStartedAt: requestStartedAt,
        requestItemSignature: signature,
        visitLatitude: originLatitude,
        visitLongitude: originLongitude,
        persisted: nil
      ),
      "missing snapshot should not discard"
    )
    expect(
      BackgroundDiscoveryPolicy.shouldDiscard(
        requestStartedAt: requestStartedAt,
        requestItemSignature: signature,
        visitLatitude: originLatitude,
        visitLongitude: originLongitude,
        persisted: BackgroundDiscoveryPolicy.PersistedSnapshot(
          generatedAt: now,
          itemSignature: "other",
          latitude: farLatitude,
          longitude: originLongitude
        )
      ),
      "newer changed signature should discard"
    )
    expect(
      BackgroundDiscoveryPolicy.shouldDiscard(
        requestStartedAt: requestStartedAt,
        requestItemSignature: signature,
        visitLatitude: originLatitude,
        visitLongitude: originLongitude,
        persisted: BackgroundDiscoveryPolicy.PersistedSnapshot(
          generatedAt: now,
          itemSignature: signature,
          latitude: originLatitude,
          longitude: originLongitude
        )
      ),
      "newer nearby anchor should discard"
    )
    expect(
      !BackgroundDiscoveryPolicy.shouldDiscard(
        requestStartedAt: requestStartedAt,
        requestItemSignature: signature,
        visitLatitude: originLatitude,
        visitLongitude: originLongitude,
        persisted: BackgroundDiscoveryPolicy.PersistedSnapshot(
          generatedAt: now,
          itemSignature: signature,
          latitude: farLatitude,
          longitude: originLongitude
        )
      ),
      "newer far anchor with the same items should still apply"
    )

    let before = BackgroundDiscoveryPolicy.commitPlan(
      expiredOrCancelledBeforeReconcile: true,
      expiredOrCancelledAfterReconcile: false
    )
    expect(!before.reconcile && !before.observe && !before.rollBack, "expiration before reconcile stops both")
    let after = BackgroundDiscoveryPolicy.commitPlan(
      expiredOrCancelledBeforeReconcile: false,
      expiredOrCancelledAfterReconcile: true
    )
    expect(after.reconcile && !after.observe && !after.rollBack, "expiration after reconcile must not roll back")

    let closeLatitude = originLatitude + 30 / 111_320
    let close = BackgroundDiscoveryPolicy.NearbyStore(
      placeId: "close",
      latitude: closeLatitude,
      longitude: originLongitude,
      selected: true,
      pending: true,
      newlyScheduled: true
    )
    let nearbyIds = BackgroundDiscoveryPolicy.alreadyNearby(
      visitAccuracyMeters: 20,
      visitLatitude: originLatitude,
      visitLongitude: originLongitude,
      stores: [
        close,
        BackgroundDiscoveryPolicy.NearbyStore(
          placeId: "far",
          latitude: farLatitude,
          longitude: originLongitude,
          selected: true,
          pending: true,
          newlyScheduled: true
        ),
        BackgroundDiscoveryPolicy.NearbyStore(
          placeId: "old",
          latitude: closeLatitude,
          longitude: originLongitude,
          selected: true,
          pending: true,
          newlyScheduled: false
        ),
      ]
    )
    expect(nearbyIds == ["close"], "already-nearby should keep only the new pending store")
    expect(
      BackgroundDiscoveryPolicy.alreadyNearby(
        visitAccuracyMeters: 100.1,
        visitLatitude: originLatitude,
        visitLongitude: originLongitude,
        stores: [close]
      ).isEmpty,
      "accuracy above 100 meters should not start an observation"
    )
    expect(
      BackgroundDiscoveryPolicy.alreadyNearby(
        visitAccuracyMeters: -1,
        visitLatitude: originLatitude,
        visitLongitude: originLongitude,
        stores: [close]
      ).isEmpty,
      "invalid accuracy should not start an observation"
    )

    let bread = BackgroundDiscoveryPolicy.Item(
      id: "bread",
      revision: 1,
      text: "Bread",
      taxonomyVersion: 1,
      categories: ["grocery-store"]
    )
    let requestedItems = BackgroundDiscoveryPolicy.itemSignature([milk, bread])
    expect(
      !BackgroundDiscoveryPolicy.shouldCommitDiscoveredItems(
        requestItemSignature: requestedItems,
        currentItems: [bread]
      ),
      "deleted item must not be committed"
    )
    expect(
      !BackgroundDiscoveryPolicy.shouldCommitDiscoveredItems(
        requestItemSignature: requestedItems,
        currentItems: [milk]
      ),
      "completed item removed from the input must not be committed"
    )
    expect(
      !BackgroundDiscoveryPolicy.shouldCommitDiscoveredItems(
        requestItemSignature: BackgroundDiscoveryPolicy.itemSignature([milk]),
        currentItems: [
          BackgroundDiscoveryPolicy.Item(
            id: "milk",
            revision: 2,
            text: "Oat milk",
            taxonomyVersion: 1,
            categories: ["grocery-store"]
          )
        ]
      ),
      "edited revision must not be committed"
    )
    expect(
      BackgroundDiscoveryPolicy.shouldCommitDiscoveredItems(
        requestItemSignature: BackgroundDiscoveryPolicy.itemSignature([milk]),
        currentItems: [milk]
      ),
      "unchanged input must commit"
    )
    expect(
      !BackgroundDiscoveryPolicy.shouldRecordFailureCooldown(after: "input-changed"),
      "discarding a changed input must not start a failure cooldown"
    )
    expect(
      BackgroundDiscoveryPolicy.shouldRecordFailureCooldown(after: "timeout"),
      "transport failure must still cool down"
    )

    return failures
  }
}
#endif
