import CoreLocation
import ExpoModulesCore
import UserNotifications

struct LocationNotificationRequestRecord: Record {
  @Field var identifier: String = ""
  @Field var title: String = ""
  @Field var body: String = ""
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
  @Field var radius: Double = 0
}

struct ScheduledLocationNotificationRecord: Record {
  @Field var identifier: String = ""
  @Field var title: String = ""
  @Field var body: String = ""
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
  @Field var radius: Double = 0
  @Field var notifyOnEntry: Bool = false
  @Field var notifyOnExit: Bool = false
  @Field var repeats: Bool = false
}

struct CandidateCoordinateRecord: Record {
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
}

struct CandidateCoordinateInputRecord: Record {
  @Field var latitude: Double? = nil
  @Field var longitude: Double? = nil
}

struct CandidateSnapshotItemInputRecord: Record {
  @Field var id: String? = nil
  @Field var revision: Int? = nil
  @Field var text: String? = nil
  @Field var categories: [String]? = nil
}

struct CandidateSnapshotStoreInputRecord: Record {
  @Field var placeId: String? = nil
  @Field var name: String? = nil
  @Field var location: CandidateCoordinateInputRecord? = nil
  @Field var itemIds: [String]? = nil
}

struct CandidateSnapshotInputRecord: Record {
  @Field var schemaVersion: Int? = nil
  @Field var generatedAt: String? = nil
  @Field var discoveryAnchor: CandidateCoordinateInputRecord? = nil
  @Field var items: [CandidateSnapshotItemInputRecord]? = nil
  @Field var stores: [CandidateSnapshotStoreInputRecord]? = nil
}

struct CandidateSnapshotItemRecord: Record {
  @Field var id: String = ""
  @Field var revision: Int = 0
  @Field var text: String = ""
  @Field var categories: [String] = []
}

struct CandidateSnapshotStoreRecord: Record {
  @Field var placeId: String = ""
  @Field var name: String = ""
  @Field var location: CandidateCoordinateRecord = CandidateCoordinateRecord()
  @Field var itemIds: [String] = []
}

struct CandidateSnapshotRecord: Record {
  @Field var schemaVersion: Int = 0
  @Field var generatedAt: String = ""
  @Field var discoveryAnchor: CandidateCoordinateRecord = CandidateCoordinateRecord()
  @Field var items: [CandidateSnapshotItemRecord] = []
  @Field var stores: [CandidateSnapshotStoreRecord] = []
}

struct NativeItemReferenceRecord: Record {
  @Field var id: String = ""
  @Field var revision: Int = 0
}

struct NativeRequestStateRecord: Record {
  @Field var placeId: String = ""
  @Field var installationId: String = ""
  @Field var fingerprint: String = ""
  @Field var status: String = ""
  @Field var items: [NativeItemReferenceRecord] = []
  @Field var isPending: Bool = false
}

struct NativeGeofenceStateRecord: Record {
  @Field var schemaVersion: Int = GeofenceNotificationConstants.stateSchemaVersion
  @Field var snapshot: CandidateSnapshotRecord?
  @Field var requests: [NativeRequestStateRecord] = []
  @Field var selectedPlaceIds: [String] = []
  @Field var pendingManagedRequestIds: [String] = []
  @Field var isDegraded: Bool = false
  @Field var observationEligible: Bool = false
  @Field var missingObservationRequirements: [String] = []
}

struct NativeSyncFailureRecord: Record {
  @Field var placeId: String = ""
  @Field var code: String = ""
  @Field var message: String = ""
}

struct NativeSyncResultRecord: Record {
  @Field var scheduledPlaceIds: [String] = []
  @Field var unchangedPlaceIds: [String] = []
  @Field var canceledPlaceIds: [String] = []
  @Field var consumedPlaceIds: [String] = []
  @Field var retainedFallbackPlaceIds: [String] = []
  @Field var failures: [NativeSyncFailureRecord] = []
  @Field var state: NativeGeofenceStateRecord = NativeGeofenceStateRecord()
}

struct BackgroundDiscoveryItemInputRecord: Record {
  @Field var id: String = ""
  @Field var revision: Int = 0
  @Field var text: String = ""
  @Field var taxonomyVersion: Int = 0
  @Field var categories: [String] = []
}

struct BackgroundDiscoveryInputRecord: Record {
  @Field var schemaVersion: Int = 0
  @Field var apiBaseUrl: String = ""
  @Field var items: [BackgroundDiscoveryItemInputRecord] = []
  @Field var updatedAt: String = ""
}

struct BackgroundDiscoveryAnchorRecord: Record {
  @Field var generatedAt: String = ""
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
  @Field var itemSignature: String = ""
  @Field var placeItemsSignature: String = ""
}

public class ThereYouGoLocationNotificationModule: Module {
  private let reconciler = ThereYouGoLocationNotificationReconciler.shared

  public func definition() -> ModuleDefinition {
    Name("ThereYouGoLocationNotification")

    let reconciler = reconciler

    AsyncFunction("syncAsync") {
      (snapshotRecord: CandidateSnapshotInputRecord) async throws -> NativeSyncResultRecord in
      do {
        let snapshot = try CandidateSnapshotValidator.validate(snapshotRecord)
        let report = try await reconciler.sync(snapshot: snapshot)
        return makeSyncResultRecord(report)
      } catch {
        throw GenericException(error.localizedDescription)
      }
    }

    AsyncFunction("getStateAsync") {
      () async throws -> NativeGeofenceStateRecord in
      do {
        return makeStateRecord(try await reconciler.getState())
      } catch {
        throw GenericException(error.localizedDescription)
      }
    }

    AsyncFunction("scheduleAsync") {
      (request: LocationNotificationRequestRecord) async throws -> String in
      let coordinate = CLLocationCoordinate2D(
        latitude: request.latitude,
        longitude: request.longitude
      )

      guard CLLocationCoordinate2DIsValid(coordinate) else {
        throw GenericException("The location notification coordinate is invalid.")
      }
      guard request.radius > 0 else {
        throw GenericException("The location notification radius must be greater than zero.")
      }

      let region = CLCircularRegion(
        center: coordinate,
        radius: request.radius,
        identifier: request.identifier
      )
      region.notifyOnEntry = true
      region.notifyOnExit = false

      let content = UNMutableNotificationContent()
      content.title = request.title
      content.body = request.body
      content.sound = .default

      let trigger = UNLocationNotificationTrigger(region: region, repeats: false)
      let notificationRequest = UNNotificationRequest(
        identifier: request.identifier,
        content: content,
        trigger: trigger
      )

      try await UNUserNotificationCenter.current().add(notificationRequest)
      return request.identifier
    }

    AsyncFunction("getScheduledAsync") {
      (identifier: String) async -> ScheduledLocationNotificationRecord? in
      let requests = await UNUserNotificationCenter.current().pendingNotificationRequests()

      if
        let request = requests.first(where: { $0.identifier == identifier }),
        let trigger = request.trigger as? UNLocationNotificationTrigger,
        let region = trigger.region as? CLCircularRegion
      {
        let result = ScheduledLocationNotificationRecord()
        result.identifier = request.identifier
        result.title = request.content.title
        result.body = request.content.body
        result.latitude = region.center.latitude
        result.longitude = region.center.longitude
        result.radius = region.radius
        result.notifyOnEntry = region.notifyOnEntry
        result.notifyOnExit = region.notifyOnExit
        result.repeats = trigger.repeats
        return result
      }

      guard
        let region = await ThereYouGoSmartArrivalRuntime.shared.monitoredRegion(
          identifier: identifier
        )
      else {
        return nil
      }

      let desired = await reconciler.desiredNotificationContent(
        forInstallationId: identifier
      )
      let result = ScheduledLocationNotificationRecord()
      result.identifier = region.identifier
      result.title = desired?.title ?? ""
      result.body = desired?.body ?? ""
      result.latitude = region.center.latitude
      result.longitude = region.center.longitude
      result.radius = region.radius
      result.notifyOnEntry = region.notifyOnEntry
      result.notifyOnExit = region.notifyOnExit
      result.repeats = false
      return result
    }

    AsyncFunction("cancelAsync") { (identifier: String) async -> Bool in
      let notificationCenter = UNUserNotificationCenter.current()
      notificationCenter.removePendingNotificationRequests(withIdentifiers: [identifier])
      let requests = await notificationCenter.pendingNotificationRequests()
      return !requests.contains(where: { $0.identifier == identifier })
    }

    AsyncFunction("armArrivalDiagnosticAsync") {
      () async throws -> ArrivalDiagnosticStatusRecord in
      do {
        return try await ThereYouGoArrivalDiagnostic.shared.arm()
      } catch {
        throw GenericException(error.localizedDescription)
      }
    }

    AsyncFunction("getArrivalDiagnosticStatusAsync") {
      () async -> ArrivalDiagnosticStatusRecord in
      await ThereYouGoArrivalDiagnostic.shared.makeStatus()
    }

    AsyncFunction("getArrivalDiagnosticResultsAsync") {
      () async -> ArrivalDiagnosticResultsRecord in
      await ThereYouGoArrivalDiagnostic.shared.results()
    }

    AsyncFunction("clearArrivalDiagnosticResultsAsync") {
      () async -> ArrivalDiagnosticResultsRecord in
      await ThereYouGoArrivalDiagnostic.shared.clearResults()
      return await ThereYouGoArrivalDiagnostic.shared.results()
    }

    AsyncFunction("disableArrivalDiagnosticAsync") {
      () async -> ArrivalDiagnosticStatusRecord in
      await ThereYouGoArrivalDiagnostic.shared.disable()
    }

    AsyncFunction("queryArrivalActivityHistoryAsync") {
      (from: String, to: String) async throws -> ArrivalDiagnosticHistoryQueryRecord in
      do {
        return try await ThereYouGoArrivalDiagnostic.shared.queryActivityHistory(
          from: from,
          to: to
        )
      } catch {
        throw GenericException(error.localizedDescription)
      }
    }

    AsyncFunction("getSmartArrivalEventHistoryAsync") {
      () -> SmartArrivalDevelopmentEventHistoryRecord in
      return smartArrivalDevelopmentEventHistory()
    }

    AsyncFunction("clearSmartArrivalEventHistoryAsync") {
      () -> SmartArrivalDevelopmentEventHistoryRecord in
      return clearSmartArrivalDevelopmentEventHistory()
    }

    AsyncFunction("startVisitDiagnosticAsync") { () async throws -> String in
      #if DEBUG
      do {
        return try await ThereYouGoVisitDiagnostic.shared.start()
      } catch {
        throw GenericException(error.localizedDescription)
      }
      #else
      throw GenericException(
        "The visit diagnostic is compiled into debug builds only."
      )
      #endif
    }

    AsyncFunction("stopVisitDiagnosticAsync") { () async -> String in
      #if DEBUG
      return await ThereYouGoVisitDiagnostic.shared.stop()
      #else
      return unavailableVisitDiagnosticResult()
      #endif
    }

    AsyncFunction("getVisitDiagnosticResultsAsync") { () async -> String in
      #if DEBUG
      return await ThereYouGoVisitDiagnostic.shared.results()
      #else
      return unavailableVisitDiagnosticResult()
      #endif
    }

    AsyncFunction("clearVisitDiagnosticResultsAsync") { () async -> String in
      #if DEBUG
      return await ThereYouGoVisitDiagnostic.shared.clear()
      #else
      return unavailableVisitDiagnosticResult()
      #endif
    }

    AsyncFunction("setBackgroundDiscoveryInputAsync") {
      (record: BackgroundDiscoveryInputRecord) async in
      let items = record.items.map { item in
        BackgroundDiscoveryPolicy.Item(
          id: item.id,
          revision: item.revision,
          text: item.text,
          taxonomyVersion: item.taxonomyVersion,
          categories: item.categories
        )
      }
      await ThereYouGoBackgroundDiscovery.shared.replaceInput(
        apiBaseUrl: record.apiBaseUrl,
        items: items,
        updatedAt: record.updatedAt
      )
    }

    AsyncFunction("noteBackgroundDiscoveryAnchorAsync") {
      (
        itemSignature: String,
        placeItemsSignature: String,
        generatedAt: String
      ) async in
      await ThereYouGoBackgroundDiscovery.shared.noteAnchor(
        itemSignature: itemSignature,
        placeItemsSignature: placeItemsSignature,
        generatedAt: generatedAt
      )
    }

    AsyncFunction("getBackgroundDiscoveryAnchorAsync") {
      () async -> BackgroundDiscoveryAnchorRecord? in
      guard
        let anchor = await ThereYouGoBackgroundDiscovery.shared.foregroundAnchor()
      else {
        return nil
      }
      let record = BackgroundDiscoveryAnchorRecord()
      record.generatedAt = anchor.generatedAt
      record.latitude = anchor.latitude
      record.longitude = anchor.longitude
      record.itemSignature = anchor.itemSignature
      record.placeItemsSignature = anchor.placeItemsSignature
      return record
    }

    AsyncFunction("getBackgroundDiscoveryEventHistoryAsync") {
      () -> BackgroundDiscoveryDevelopmentEventHistoryRecord in
      backgroundDiscoveryDevelopmentEventHistory()
    }

    AsyncFunction("clearBackgroundDiscoveryEventHistoryAsync") {
      () -> BackgroundDiscoveryDevelopmentEventHistoryRecord in
      clearBackgroundDiscoveryDevelopmentEventHistory()
    }

    AsyncFunction("debugSimulateBackgroundVisitAsync") {
      (
        latitude: Double,
        longitude: Double,
        horizontalAccuracy: Double
      ) async throws -> String in
      #if DEBUG
      return await ThereYouGoBackgroundDiscovery.shared.simulateVisit(
        latitude: latitude,
        longitude: longitude,
        horizontalAccuracy: horizontalAccuracy
      )
      #else
      throw GenericException(
        "Background discovery simulation is compiled into debug builds only."
      )
      #endif
    }

    AsyncFunction("debugValidateBackgroundDiscoveryAsync") {
      () async -> String in
      await ThereYouGoBackgroundDiscovery.shared.debugValidationJSON()
    }
  }
}

#if !DEBUG
private func unavailableVisitDiagnosticResult() -> String {
  #"{"schemaVersion":1,"available":false,"isMonitoring":false,"detail":"debug-build-required","events":[]}"#
}
#endif

private func makeSyncResultRecord(
  _ report: NativeSyncReport
) -> NativeSyncResultRecord {
  let result = NativeSyncResultRecord()
  result.scheduledPlaceIds = report.scheduledPlaceIds
  result.unchangedPlaceIds = report.unchangedPlaceIds
  result.canceledPlaceIds = report.canceledPlaceIds
  result.consumedPlaceIds = report.consumedPlaceIds
  result.retainedFallbackPlaceIds = report.retainedFallbackPlaceIds
  result.failures = report.failures.map { failure in
    let record = NativeSyncFailureRecord()
    record.placeId = failure.placeId
    record.code = failure.code
    record.message = failure.message
    return record
  }
  result.state = makeStateRecord(report.state)
  return result
}

private func makeStateRecord(
  _ state: NativeGeofenceStateView
) -> NativeGeofenceStateRecord {
  let record = NativeGeofenceStateRecord()
  record.snapshot = state.snapshot.map(makeSnapshotRecord)
  record.requests = state.requests.map { request in
    let requestRecord = NativeRequestStateRecord()
    requestRecord.placeId = request.placeId
    requestRecord.installationId = request.installationId
    requestRecord.fingerprint = request.fingerprint
    requestRecord.status = request.status.rawValue
    requestRecord.items = request.itemReferences.map { item in
      let itemRecord = NativeItemReferenceRecord()
      itemRecord.id = item.id
      itemRecord.revision = item.revision
      return itemRecord
    }
    requestRecord.isPending = request.isPending
    return requestRecord
  }
  record.selectedPlaceIds = state.selectedPlaceIds
  record.pendingManagedRequestIds = state.pendingManagedRequestIds
  record.isDegraded = state.isDegraded
  record.observationEligible = state.observationEligible
  record.missingObservationRequirements = state.missingObservationRequirements
  return record
}

private func makeSnapshotRecord(
  _ snapshot: PersistedCandidateSnapshot
) -> CandidateSnapshotRecord {
  let record = CandidateSnapshotRecord()
  record.schemaVersion = snapshot.schemaVersion
  record.generatedAt = snapshot.generatedAt
  record.discoveryAnchor = makeCoordinateRecord(snapshot.discoveryAnchor)
  record.items = snapshot.items.map { item in
    let itemRecord = CandidateSnapshotItemRecord()
    itemRecord.id = item.id
    itemRecord.revision = item.revision
    itemRecord.text = item.text
    itemRecord.categories = item.categories
    return itemRecord
  }
  record.stores = snapshot.stores.map { store in
    let storeRecord = CandidateSnapshotStoreRecord()
    storeRecord.placeId = store.placeId
    storeRecord.name = store.name
    storeRecord.location = makeCoordinateRecord(store.location)
    storeRecord.itemIds = store.itemIds
    return storeRecord
  }
  return record
}

private func makeCoordinateRecord(
  _ coordinate: PersistedCoordinate
) -> CandidateCoordinateRecord {
  let record = CandidateCoordinateRecord()
  record.latitude = coordinate.latitude
  record.longitude = coordinate.longitude
  return record
}
