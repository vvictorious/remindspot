# Native geofence scheduling tests

This Expo module has no XCTest target. The generated `/ios` project is gitignored, so the repository cannot run Swift unit tests in CI.

Covered without a device:

- TypeScript snapshot construction (`src/hooks/geofence-candidate-snapshot.spec.ts`)
- Portable native contract checks (`src/native/geofence-native-contract.spec.ts`): validation, item-aware 15-store selection, notification copy, and transition classification

Not covered without a physical iPhone:

- `UNUserNotificationCenter` add/readback/cancel
- UserDefaults persistence across process launches
- Actual location-trigger delivery

Swift remains the runtime source of truth. The TypeScript contract file documents the same rules and cannot schedule notifications.

## Manual iPhone verification

Use a development build. `HomeScreen` now drives the native reconciler from
hydrated items and complete committed Places discovery.

1. Grant notification permission and When In Use location. Do not request Always.
2. Start Metro with the API URL reachable from the iPhone, add a destination
   item, and wait for classification and Places discovery.
   - Metro logs a `[geofence] sync complete` entry.
   - The entry reports at least one `scheduledPlaceId` and no failures.
3. Background or force-quit the app, then enter one of the scheduled stores.
   - Expect one notification titled `At <store name>`.
   - The body lists the associated active item names.
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
9. After a real arrival, `getScheduledAsync` returns `null` and a later identical `syncAsync` reports the store in `consumedPlaceIds` without creating a new request.

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
   a 100-meter region still produces the one-shot notification.

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
