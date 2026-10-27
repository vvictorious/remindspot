import ExpoModulesCore
import Foundation

// Debug-only history for background discovery. Release builds do not collect
// or persist these events, and nothing in the log is sent off the device.

struct BackgroundDiscoveryDevelopmentEventRecord: Record {
  @Field var sequence: Int = 0
  @Field var recordedAt: String = ""
  @Field var type: String = ""
  @Field var detail: String? = nil
  @Field var durationSeconds: Double? = nil
  @Field var accuracyMeters: Double? = nil
  @Field var distanceFromAnchorMeters: Double? = nil
  @Field var storeCount: Int? = nil
  @Field var storeName: String? = nil
}

struct BackgroundDiscoveryDevelopmentEventHistoryRecord: Record {
  @Field var droppedEventCount: Int = 0
  @Field var events: [BackgroundDiscoveryDevelopmentEventRecord] = []
}

func backgroundDiscoveryDevelopmentEventHistory()
  -> BackgroundDiscoveryDevelopmentEventHistoryRecord
{
  #if DEBUG
  return BackgroundDiscoveryDevelopmentEventLog.historyRecord()
  #else
  return BackgroundDiscoveryDevelopmentEventHistoryRecord()
  #endif
}

func clearBackgroundDiscoveryDevelopmentEventHistory()
  -> BackgroundDiscoveryDevelopmentEventHistoryRecord
{
  #if DEBUG
  BackgroundDiscoveryDevelopmentEventLog.clear()
  #endif
  return backgroundDiscoveryDevelopmentEventHistory()
}

#if DEBUG

private struct BackgroundDiscoveryDevelopmentEvent: Codable {
  var sequence: Int
  var recordedAt: String
  var type: String
  var detail: String?
  var durationSeconds: Double?
  var accuracyMeters: Double?
  var distanceFromAnchorMeters: Double?
  var storeCount: Int?
  var storeName: String?
}

private struct BackgroundDiscoveryDevelopmentEventEnvelope: Codable {
  var droppedEventCount: Int
  var nextSequence: Int
  var events: [BackgroundDiscoveryDevelopmentEvent]
}

private enum BackgroundDiscoveryDevelopmentEventLogStore {
  static let maximumEvents = 100
  static let userDefaultsKey =
    "there-you-go.background-discovery.development-events.v1"
  static let lock = NSLock()

  static func read() -> BackgroundDiscoveryDevelopmentEventEnvelope {
    guard
      let data = UserDefaults.standard.data(forKey: userDefaultsKey),
      let envelope = try? JSONDecoder().decode(
        BackgroundDiscoveryDevelopmentEventEnvelope.self,
        from: data
      )
    else {
      return BackgroundDiscoveryDevelopmentEventEnvelope(
        droppedEventCount: 0,
        nextSequence: 1,
        events: []
      )
    }
    return envelope
  }

  static func write(_ envelope: BackgroundDiscoveryDevelopmentEventEnvelope) {
    guard let data = try? JSONEncoder().encode(envelope) else {
      return
    }
    UserDefaults.standard.set(data, forKey: userDefaultsKey)
  }
}

enum BackgroundDiscoveryDevelopmentEventLog {
  static func historyRecord() -> BackgroundDiscoveryDevelopmentEventHistoryRecord {
    BackgroundDiscoveryDevelopmentEventLogStore.lock.lock()
    let envelope = BackgroundDiscoveryDevelopmentEventLogStore.read()
    BackgroundDiscoveryDevelopmentEventLogStore.lock.unlock()
    let record = BackgroundDiscoveryDevelopmentEventHistoryRecord()
    record.droppedEventCount = envelope.droppedEventCount
    record.events = envelope.events.map { event in
      let item = BackgroundDiscoveryDevelopmentEventRecord()
      item.sequence = event.sequence
      item.recordedAt = event.recordedAt
      item.type = event.type
      item.detail = event.detail
      item.durationSeconds = event.durationSeconds
      item.accuracyMeters = event.accuracyMeters
      item.distanceFromAnchorMeters = event.distanceFromAnchorMeters
      item.storeCount = event.storeCount
      item.storeName = event.storeName
      return item
    }
    return record
  }

  static func clear() {
    BackgroundDiscoveryDevelopmentEventLogStore.lock.lock()
    UserDefaults.standard.removeObject(
      forKey: BackgroundDiscoveryDevelopmentEventLogStore.userDefaultsKey
    )
    BackgroundDiscoveryDevelopmentEventLogStore.lock.unlock()
  }

  static func record(
    type: String,
    detail: String? = nil,
    durationSeconds: Double? = nil,
    accuracyMeters: Double? = nil,
    distanceFromAnchorMeters: Double? = nil,
    storeCount: Int? = nil,
    storeName: String? = nil,
    at date: Date = Date()
  ) {
    BackgroundDiscoveryDevelopmentEventLogStore.lock.lock()
    defer { BackgroundDiscoveryDevelopmentEventLogStore.lock.unlock() }
    var envelope = BackgroundDiscoveryDevelopmentEventLogStore.read()
    envelope.events.append(
      BackgroundDiscoveryDevelopmentEvent(
        sequence: envelope.nextSequence,
        recordedAt: timestamp(date),
        type: type,
        detail: detail,
        durationSeconds: durationSeconds.map(rounded),
        accuracyMeters: accuracyMeters.map(rounded),
        distanceFromAnchorMeters: distanceFromAnchorMeters.map(rounded),
        storeCount: storeCount,
        storeName: storeName
      )
    )
    envelope.nextSequence += 1
    let overflow =
      envelope.events.count -
      BackgroundDiscoveryDevelopmentEventLogStore.maximumEvents
    if overflow > 0 {
      envelope.droppedEventCount += overflow
      envelope.events.removeFirst(overflow)
    }
    BackgroundDiscoveryDevelopmentEventLogStore.write(envelope)
  }

  private static func timestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private static func rounded(_ value: Double) -> Double {
    (value * 1_000).rounded() / 1_000
  }
}

#endif
