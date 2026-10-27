# Native geofence scheduling tests

This Expo module has no XCTest target. The generated `/ios` project is gitignored, so the repository cannot run Swift unit tests in CI.

Covered without a device:

- TypeScript snapshot construction (`src/hooks/geofence-candidate-snapshot.spec.ts`)
- Portable native contract checks (`src/native/geofence-native-contract.spec.ts`): validation, item-aware 15-store selection, notification copy, and transition classification
- Portable Smart Arrival state checks (`src/native/smart-arrival-state.spec.ts`):
  persisted schema-v1 migration, duplicate entry and identifier handling,
  per-store walking proximity, conservative drive-away, absolute timeout,
  reconciliation invalidation and reload, registration-bound delivery intents,
  interrupted-delivery recovery decisions, and overlapping observations
- Portable Smart Arrival runtime checks (`src/native/smart-arrival-runtime.spec.ts`):
  iOS 18+ eligibility without immediate-notification fallback, explicit missing
  Always/Precise/Motion/notification requirements, degraded installed regions,
  missing-region re-registration, conservative 20-slot occupancy, leftover managed
  trigger cancellation, shared observation streams, and reconstruction deadlines

Not covered without a physical iPhone:

- `CLLocationManager` region registration readback
- Shared `CLLocationUpdate` / Core Motion observation
- UserDefaults persistence across process launches
- Background delivery while the process is suspended

Swift remains the runtime source of truth. The TypeScript contract file documents the same rules and cannot schedule notifications.

Production Smart Arrival registers `CLCircularRegion`s and observes entered
stores for at most 240 seconds. A qualified walking arrival submits one
immediate local notification and then consumes that registration. The
notification does not use `UNLocationNotificationTrigger`. Leftover managed
location-notification triggers are cancelled and are not treated as consumed
tombstones. Launch restoration and sync count the same 20-slot union of
monitored regions and pending location triggers. Always location and Motion
are requested only in the foreground. Missing observation permissions leave an
installed region degraded instead of restoring immediate geofence delivery.

Portable distance tests deliberately avoid exact radius and drive-away
boundaries. Swift uses Core Location's device-platform distance calculation;
the TypeScript contract uses deterministic Haversine distance, so sub-meter
boundary results are not expected to be bit-for-bit identical.

Delivery recovery consults pending and delivered identifiers before submission.
A known pending or delivered identifier is consumed and is not submitted again.
An unknown identifier is submitted. Successful `add` completion consumes the
registration immediately. A definite add failure leaves the intent in place.
If iOS no longer reports a notification that was visibly delivered before a
crash, a later retry may display it again; exactly-once visible delivery is
not guaranteed.

## Manual iPhone verification

Use a development build. `HomeScreen` now drives the native reconciler from
hydrated items and complete committed Places discovery.

1. Grant When In Use location. The foreground sync requests Always location and
   Motion. Precise location, notification permission, Always, and Motion are
   required before an installed region is observation-eligible. Missing
   permissions set `isDegraded` and list `missingObservationRequirements`;
   they must not restore immediate geofence notifications.
2. Start Metro with the API URL reachable from the iPhone, add a destination
   item, and wait for classification and Places discovery.
   - Metro logs a `[geofence] sync complete` entry.
   - The entry reports at least one `scheduledPlaceId` and no failures.
3. Background or force-quit the app, then enter one of the scheduled stores and
   walk inside its 100-meter region within 240 seconds.
   - Smart Arrival submits one immediate notification, `At <store name>`,
     whose body lists the associated items.
   - The managed region is then consumed and is no longer pending.
4. Complete, delete, or edit an associated item before entering the store.
   - Metro logs cancellation or replacement of the obsolete schedule.
   - The obsolete item text must not appear in a later notification.
5. Undo completion.
   - The old candidate is not restored until fresh Places discovery completes.

For lower-level reconciliation diagnostics, call the module from the Metro
console or a temporary debug screen:

1. On a fresh install, call
   `await ThereYouGoLocationNotification.getStateAsync()`.
   - Expect `snapshot: null`, empty `requests`, `isDegraded: false`.
2. Sync a far-away two-store snapshot (for example, coordinates several kilometers from your current location) with two items on store A and one item on store B.
   - `syncAsync` should report both store IDs in `scheduledPlaceIds`.
   - `state.snapshot.stores` should contain the full pool.
   - `state.selectedPlaceIds` should contain both stores.
   - `state.requests` should have `tyg.arrival.v1.` installation IDs, `status: "pending"`, and `isPending: true`.
3. Call `getScheduledAsync(installationId)` for each request.
   - Radius is 100.
   - `notifyOnEntry` is true, `notifyOnExit` is false, `repeats` is false.
   - Title is `At <store name>`.
   - Body lists the associated item names.
   - This now reads the managed monitored region, not a pending
     `UNLocationNotificationTrigger`.
4. Sync the identical snapshot again.
   - `unchangedPlaceIds` contains both stores.
   - Installation IDs do not change.
5. Sync a snapshot that completes/removes one item from store A.
   - Store A is canceled first, then scheduled with a new installation ID and only the remaining item text.
   - Store B is unchanged.
6. Sync an authoritative empty snapshot (`items: []`, `stores: []`).
   - All managed requests are canceled.
   - Unrelated pending notifications created with `scheduleAsync` remain.
7. Sync 17 stores: 15 nearby stores for one common item, then a farther
   auto-parts store and pet store for two otherwise uncovered items.
   - `state.snapshot.stores.length === 17`
   - `state.selectedPlaceIds.length === 15`
   - The two specialist stores and the 13 nearest common-item stores are
     selected, in distance order.
   - Only those 15 pending IDs are present.
8. Sync the original two-store snapshot, force-quit the app, relaunch, then `getStateAsync()`.
   - The persisted snapshot and pending IDs match the last successful sync.
9. After a real walking arrival, the notification is delivered and the managed
   region is consumed. A drive-away or the 240-second deadline ends the
   observation without a notification.

Use far-away coordinates for diagnostic steps 2-8 so you do not trigger live
notifications. Use a real nearby store only for step 9.

## 100-meter migration and duplicate-store verification

1. With a build that still uses 150 meters, schedule requests while outside all
   test regions and record their installation IDs.
2. Install the 100-meter build over the existing app without deleting its data,
   then launch it and wait for item hydration and geofence sync.
   - Each selected pending store gets a fresh installation ID.
   - `getScheduledAsync` reports radius 100 for every replacement.
   - The old 150-meter IDs are absent, sync has no failures, and
     `isDegraded` is false.
3. Sync co-located `CVS` and `CVS Pharmacy` candidates no more than 30 meters
   apart, with different associated items.
   - Only the deterministic representative is selected and pending.
   - Its body and `itemIds` contain the union of both stores' items.
4. Add a differently named business at the same coordinate and an equivalent
   business name more than 30 meters away.
   - Both remain independently selected.
5. Background or force-quit the app, disconnect Metro, and verify that entering
   a 100-meter region and walking there submits one immediate notification.
   The diagnostic region remains independent of that delivery.

Consumed entries are same-fingerprint tombstones. Because radius participates
in the fingerprint, changing from 150 to 100 meters treats an already consumed
entry as changed content and rearms it once at the new radius. This is accepted
for the development-stage migration; no schema or one-off migration logic is
required.

## Correctness regression scenarios

These scenarios exercise native behavior that the portable TypeScript contract
cannot prove:

1. Start two `syncAsync` calls and one `getStateAsync` call without awaiting
   between them. Each completed state must be internally consistent, with no
   duplicate managed requests or orphaned installation IDs.
2. Interrupt the process after cancellation intent is persisted but before the
   request is removed. On the next `syncAsync` or `getStateAsync`, native code
   must finish that cancellation and clear the degraded state.
3. Change notification content for a pending store and make old-request
   cancellation fail. The old ID must remain tracked as cleanup-pending,
   `isDegraded` must be true, and the next operation must retry cleanup.
4. Deliver a request, sync a snapshot that temporarily omits that store while
   retaining the same item ID and revision, then restore the store. The consumed
   fingerprint must not be rearmed.
5. Call `syncAsync` from untyped JavaScript with `items`, `stores`,
   `discoveryAnchor`, or a nested store location omitted. Each call must reject
   without changing native state. A snapshot containing explicit empty
   `items: []` and `stores: []` must still succeed.
6. Sync a newer snapshot, then submit an older `generatedAt` snapshot and an
   equal-timestamp snapshot with different content. Both must reject without
   changing pending requests or persisted state.
7. Fill all 20 location-trigger slots with 15 managed stores and 5 unrelated
   requests, then rotate the candidate anchor so a different managed store is
   selected. Native code may retire one unselected managed fallback, but all
   unrelated requests must remain.
8. Replace the persisted state value with malformed data while managed requests
   exist. The next operation must quarantine the data, clean only requests with
   the `tyg.arrival.v1.` prefix, and rebuild from the supplied valid snapshot.

`generatedAt` remains the ordering key because `CandidateSnapshotV1` has no
monotonic generation field. It must be a canonical UTC timestamp produced by
`Date.prototype.toISOString()`. Device-clock rollback remains a documented
beta limitation; adding a durable generation counter belongs with the future
producer/rotation contract rather than Milestone 6B.2.

## Milestone 7C: iOS 18+ arrival lifecycle diagnostic

This diagnostic-only lifecycle proof of concept requires iOS 18 or later. It
is disabled by default and is not part of notification reconciliation. It
monitors only Trader Joe's store #119, West Los Angeles - Sepulveda, at
3456 S Sepulveda Blvd, Los Angeles, CA 90034 (`34.0203234, -118.4220680`)
with the identifier `tyg.diagnostic.arrival.v1.trader-joes-119` and a
75-meter radius. The 2026-10-19 visit used this same identifier at 100
meters; those events stay in the record. On 2026-10-19 the official store page confirmed store 119
and that address, and OpenStreetMap node 276600064 supplied the coordinate.
That node is tagged Trader Joe's, `ref=119`, house number 3456, and links to
the same official page. It never
creates, removes, delays, or changes a `UNNotificationRequest`.

The diagnostic stores a maximum of 512 events in `UserDefaults`. Schema v3
explicitly migrates schema-v2 history under the same
`there-you-go.arrival-diagnostic.state.v1` key while preserving all events,
fields, and sequence numbers. Do not call `clear()` before or after the target change or the
first Trader Joe's visit. Existing Shell Food Mart events remain in this same
record with their original timestamps and sequence numbers; their saved
distances still refer to Shell and are not recalculated. The results header
shows the current Trader Joe's target. A location
sample contains its timestamp, age, horizontal accuracy, speed, speed accuracy,
distance from the test store, and elapsed observation time. An
`activity-classification` event stores automotive, stationary, walking,
running, unknown, and cycling flags, confidence, the activity's own start
timestamp, and a `detail` of
`source:labels:confidence`. It does not persist the phone's coordinate and
does not transmit results. `results().radiusMeters` is the current 75-meter
configuration, including when older events were recorded at 100 meters.

On entry, the diagnostic starts a default `CLLocationUpdate.liveUpdates()`
stream with an absolute 240-second UTC deadline under a retained foreground-
established `CLServiceSession(.always)`. A relaunch keeps the deadline stored
at observation start and does not extend it when this duration changes. It never
starts legacy `CLLocationManager.startUpdatingLocation` and never creates a
`CLBackgroundActivitySession`. It records one diagnostic
`smart-arrival-would-notify` event per observation and at most one passive
`drive-away-would-end` event. Neither event schedules, delivers, delays, or
suppresses production notifications. Arming stops every
`tyg.diagnostic.arrival.v1.` region, including the former Shell Food Mart
region `tyg.diagnostic.arrival.v1.shell-3801`, and then registers only the
Trader Joe's region. A launch while disarmed also retires any non-current
diagnostic region. A launch while armed retires those stale regions and then
registers the current region without stopping and recreating it. Retirement
appends `diagnostic-region-retired` and does not clear history.

### Build and arm on a physical iPhone

Do not run `expo prebuild --clean`. The generated iOS project already contains
the opted-in diagnostic configuration that this experiment must keep.
Use a physical iPhone running iOS 18 or later. On an older OS, `arm()` returns
an explicit unsupported-version error; it does not run the previous location
burst.

1. Start outside the 75-meter test region with ThereYouGo active in the
   foreground. For a clean entry transition, begin
   at least 200 meters away and allow iOS several minutes to establish the
   outside state.
2. Rebuild and install over the existing diagnostic iOS project:

   ```bash
   TYG_IOS_ARRIVAL_DIAGNOSTIC=1 npx expo run:ios --device
   ```

3. Start Metro for the installed development client:

   ```bash
   npx expo start --dev-client
   ```

4. Open React Native DevTools by pressing `j` in the Metro terminal. In its
   console, inspect the inactive state:

   ```js
   await globalThis.tygArrivalDiagnostic.status()
   ```

   Expect `buildEnabled`, `backgroundModeEnabled`,
   `regionMonitoringAvailable`, `serviceSessionSupported`,
   `liveUpdatesSupported`, and
   `backgroundRefreshStatus === "available"`.
   The first two values must be `true`. Confirm
   `storeName === "Trader Joe's"` and
   `latitude/longitude` match `34.0203234, -118.422068`.
5. Arm the experiment:

   ```js
   await globalThis.tygArrivalDiagnostic.arm()
   ```

   The first call may only request elevated permission. In iPhone Settings,
   open **Privacy & Security > Location Services > ThereYouGo**, select
   **Always**, and enable **Precise Location**. Also verify **General >
   Background App Refresh** is enabled for ThereYouGo. Grant **Privacy &
   Security > Motion & Fitness > ThereYouGo** when the system prompt appears,
   and confirm **Fitness Tracking** is enabled at the top of that Motion &
   Fitness screen. Return to the app and call `arm()` again if location was
   still When In Use.
6. Confirm the returned status has:
   - `authorizationStatus: "always"`
   - `accuracyAuthorization: "full"`
   - `motionAvailable: true`
   - `motionAuthorizationStatus: "authorized"`
   - `isArmed: true`
   - `serviceSessionSupported: true`
   - `serviceSessionActive: true`
   - `liveUpdatesSupported: true`
   - `observationActive: false`
   - `observationDeadline: null`
   - `observationDurationSeconds: 240`
   - `diagnosticRegionRegistered: true` (allow a few seconds and call
     `status()` again if monitoring has not started yet). This is true only
     when the monitored region identifier matches and its radius reads back
     as 75 meters. `region-monitoring-started` records both the requested
     radius and that read-back. A `diagnostic-region-radius-mismatch` event
     means the monitored radius is still different; the diagnostic does not
     stop or recreate the region after that reading.
   - `conservativeOccupiedRegionCount <= 20`

   Arming must occur while the app is active. This establishes the Always
   service session while the app is in use. Motion permission is also requested
   while the app is foregrounded during `arm()`.
   A denied or unavailable motion status does not prevent arming; GPS capture
   still runs. If `motionAuthorizationStatus` is not `"authorized"`, activity
   events will be missing and that is a recorded limitation, not a harness
   failure.

Arming unions pending location-notification identifiers with programmable
monitored-region identifiers. It refuses to add a twenty-first conservative
slot and treats any prior `tyg.diagnostic.arrival.v1.` identifier as the
reusable diagnostic slot. The normal item-aware scheduler still selects at
most 15 production stores, and the diagnostic uses a different identifier
namespace. Do not run the low-level 20-slot capacity test or manually add
unrelated location triggers while this diagnostic is armed.

### First physical lifecycle visit

Use one legitimate visit, not repeated drive-bys. Do not interact with the
phone while driving, do not force-quit ThereYouGo, and do not clear the
existing diagnostic history.

1. While parked and at least 200 meters outside the region, foreground the app,
   call `arm()`, and confirm Always, Precise, Motion, Background App Refresh,
   `serviceSessionActive`, and `diagnosticRegionRegistered`.
2. Background and lock the phone.
3. Enter the Trader Joe's region, park normally, and walk into the store.
4. Reopen ThereYouGo only after the persisted 240-second deadline has passed.
5. Print the complete preserved record:

```js
JSON.stringify(await globalThis.tygArrivalDiagnostic.results(), null, 2)
```

Compare the new observation identifier and sequence numbers with the preserved
prior visit. Production reminders remain scheduled and may fire normally.
Compare `region-enter-callback.recordedAt` with any production notification's
observed delivery time. For each `live-location-update`, require
`isFreshLocation: true` before interpreting accuracy, speed, or distance.
`observation-ended.executionDurationSeconds` shows elapsed wall-clock time, not
guaranteed background execution.

For motion, do not expect a live `activity-classification` on every location
sample. Core Motion does not independently wake a suspended app. The historical
query fired at observation start looks back 120 seconds and keeps at most 16 recent
activities. Interpret those events using `activityStartTimestamp` (when
Core Motion classified the activity) and `recordedAt` (when the diagnostic
persisted it). `detail` starts with `historical-query`, `live`, or
`authorization-prompt`. An `activity-query-empty`, `activity-query-failed`,
or `motion-updates-skipped` event is a valid feasibility result.

The expected sequence is:

1. `service-session-established` with `foreground-arm`
2. `region-enter-callback`
3. `live-observation-started` with an absolute UTC deadline
4. `motion-updates-started`
5. historical `activity-classification` records
6. `live-location-update` records, including nil-location updates and flags
7. optionally `uikit-background-task-expired`
8. additional location or motion records after that UIKit event
9. a walking classification if Core Location wakes or runs the app in time
10. at most one `drive-away-would-end` when high-confidence automotive activity
    after entry coincides with a fresh location at least 125 meters from the
    store, at least 50 meters farther than the closest accurate sample, and
    moving at least 4 m/s. Horizontal accuracy must be 15 meters or better and
    speed accuracy 1 m/s or better. Samples worse than 15 meters, including the
    loose fixes at observation start, do not count as the closest baseline.
    This event does not end the observation. A later walking decision is still
    recorded.
11. at most one `smart-arrival-would-notify` after a high-confidence walking
    sample whose `activityStartTimestamp` is at or after observation start.
    `recordedAt`, `decisionAt`, and `elapsedSeconds` are when that evidence
    was available. `activityStartTimestamp` and `walkingStartedAt` are when
    Core Motion says walking began. `priorAutomotive=none` is valid;
    automotive fields are included only when an earlier sample in the same
    observation was already recorded. The event also copies the latest fresh
    location's distance, speed, accuracy, and sample age, plus remaining
    deadline time, whether the UIKit setup task is still active, and whether
    the observation was reconstructed. This event does not schedule a
    notification, and the observation continues until its deadline.
12. `observation-ended` with an explicit reason

Possible reasons include `deadline-timer-fired`,
`deadline-detected-on-live-update`,
`deadline-detected-on-motion-callback`, `deadline-detected-on-launch`,
`deadline-detected-on-lifecycle`, `live-update-stream-ended`,
`live-update-stream-error`, `diagnostic-disabled`, and
`authorization-invalid`.

Strong feasibility evidence is a location update or walking classification
recorded after `uikit-background-task-expired` and before the persisted
deadline. UIKit expiration only ends that UIKit assertion; it never ends the
Core Location observation. `inferred-callback-gap` reports only its measured
gap and is not proof of suspension. `observed-process-launch` followed by
`observed-session-reconstruction` and `live-observation-reconstructed` is
direct evidence that reconstruction occurred, but iOS does not report why the
previous process ended.

### Lifecycle limitations and cleanup

iOS applies region-entry heuristics; boundary callbacks can arrive minutes
after a crossing and are not guaranteed at exactly 75 meters. The UIKit
background task is a finite setup/persistence assertion, not a guarantee of
runtime and not an app-suspension signal. There is no UIKit suspension
callback. The 240-second value is an absolute observation deadline, not a
guaranteed background window. If the process is suspended when the deadline
passes, cleanup occurs on the next Core Location wake or foreground lifecycle
callback.

Default live updates may pause while stationary and resume when movement is
observed; the diagnostic does not end on `stationary`. Outstanding live
updates can cause later Core Location delivery or relaunch, but region and
stream behavior still depends on Always and Precise authorization, an active
Always service session, Background App Refresh, device state, and first unlock
after reboot. User force-quit is not recoverable and suppresses relaunch.
Motion updates exist only during an active observation and stop at cleanup.

When testing is complete, run:

```js
await globalThis.tygArrivalDiagnostic.disable()
await globalThis.tygArrivalDiagnostic.status()
```

Verify `isArmed`, `diagnosticRegionRegistered`, `serviceSessionActive`, and
`observationActive` are all `false`. `disable()` cancels live updates and
motion, releases the service session, ends any active UIKit assertion, and
unregisters only identifiers beginning with `tyg.diagnostic.arrival.v1.`. It
does not clear diagnostic history.

Restore the original native configuration by rebuilding without the opt-in
environment variable. Do not use `--clean` unless you are intentionally
discarding the generated diagnostic iOS project:

```bash
unset TYG_IOS_ARRIVAL_DIAGNOSTIC
npx expo run:ios --device
```

Launch that build once; it defensively cleans up persisted diagnostic activity
if the explicit `disable()` step was missed. Confirm the default native config
contains no location background mode:

```bash
npx expo config --type introspect --json | node -e \
'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).ios.infoPlist;console.log(p.TYGArrivalDiagnosticEnabled,p.UIBackgroundModes??[])})'
```

Expected output is `false ["location"]` after Phase 2, because production Smart
Arrival requires the Location Updates background mode. Finally, in iPhone
Settings, change ThereYouGo
from **Always** back to **While Using the App** to restore the original
permission level. Keep Precise Location enabled for the existing production
notification behavior. Turn off **Privacy & Security > Motion & Fitness >
ThereYouGo** if it was granted only for this diagnostic.

## Background discovery on a physical iPhone

Background discovery starts `CLVisit` monitoring during launch when saved
classified items exist and the phone already has Always and Precise location.
It does not request a new permission. The Mac must be running the NestJS
server on the same Wi-Fi, and `EXPO_PUBLIC_API_BASE_URL` must be that Mac's
LAN address. A successful Metro simulation does not measure how long iOS will
keep the process awake for a real visit.

1. Launch the dev build once with items classified, then force-quit and
   relaunch. In the Metro console, `tygBackgroundDiscovery.history()` should
   include `monitoring-started` with `origin=launch` or
   `origin=launch-location`. With no classified items, the event is
   `monitoring-not-started`.
2. `await tygBackgroundDiscovery.validate()` runs the native eligibility,
   response-gating, and already-nearby checks. `passed` should be true.
3. With the server running, simulate a visit at the phone's current
   coordinate:
   `await tygBackgroundDiscovery.simulate(latitude, longitude, 30)`.
   The history should show `discovery-started`, `reconciliation-applied`, and
   any `observation-started` events. Smart Arrival history may show
   `region-entry`. It must not show `notification-succeeded` from the visit
   coordinate alone.
4. Simulate the same coordinate again. The second call should skip with
   `unchanged-nearby-anchor` and the server should not log another Places
   request.
5. Stop the server and simulate a coordinate at least 1.2 km away. The
   previous `getStateAsync()` snapshot should remain.
6. The debug visit recorder is unchanged. `tygVisitDiagnostic.start()` still
   records visits and does not discover stores or notify.

`CLVisit` is not delivered in the Simulator. An away-from-home, backgrounded,
or force-quit field test waits until the phone can reach the backend without
a tunnel.
