# Native geofence scheduling tests

This Expo module has no XCTest target. The generated `/ios` project is gitignored, so the repository cannot run Swift unit tests in CI.

Covered without a device:

- TypeScript snapshot construction (`src/hooks/geofence-candidate-snapshot.spec.ts`)
- Portable native contract checks (`src/native/geofence-native-contract.spec.ts`): validation, nearest-15 selection, notification copy, and transition classification

Not covered without a physical iPhone:

- `UNUserNotificationCenter` add/readback/cancel
- UserDefaults persistence across process launches
- Actual location-trigger delivery

Swift remains the runtime source of truth. The TypeScript contract file documents the same rules and cannot schedule notifications.

## Manual iPhone verification

Use a development build. Do not wire HomeScreen. Call the module from a temporary Metro console, a one-off debug screen, or `jscmd` in the debugger.

1. Grant notification permission and When In Use location. Do not request Always.
2. `await ThereYouGoLocationNotification.getStateAsync()`
   - Expect `snapshot: null`, empty `requests`, `isDegraded: false`.
3. Sync a far-away two-store snapshot (for example, coordinates several kilometers from your current location) with two items on store A and one item on store B.
   - `syncAsync` should report both store IDs in `scheduledPlaceIds`.
   - `state.snapshot.stores` should contain the full pool.
   - `state.selectedPlaceIds` should contain both stores.
   - `state.requests` should have `tyg.arrival.v1.` installation IDs, `status: "pending"`, and `isPending: true`.
4. Call `getScheduledAsync(installationId)` for each request.
   - Radius is 150.
   - `notifyOnEntry` is true, `notifyOnExit` is false, `repeats` is false.
   - Title is `At <store name>`.
   - Body lists the associated item names.
5. Sync the identical snapshot again.
   - `unchangedPlaceIds` contains both stores.
   - Installation IDs do not change.
6. Sync a snapshot that completes/removes one item from store A.
   - Store A is canceled first, then scheduled with a new installation ID and only the remaining item text.
   - Store B is unchanged.
7. Sync an authoritative empty snapshot (`items: []`, `stores: []`).
   - All managed requests are canceled.
   - Unrelated pending notifications created with `scheduleAsync` remain.
8. Sync 16 stores at increasing distances.
   - `state.snapshot.stores.length === 16`
   - `state.selectedPlaceIds.length === 15`
   - Only the 15 nearest pending IDs are present.
9. Sync the original two-store snapshot, force-quit the app, relaunch, then `getStateAsync()`.
   - The persisted snapshot and pending IDs match the last successful sync.
10. After a real arrival, `getScheduledAsync` returns `null` and a later identical `syncAsync` reports the store in `consumedPlaceIds` without creating a new request.

Use far-away coordinates for steps 3-9 so you do not trigger live notifications. Use a real nearby store only for step 10.

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
