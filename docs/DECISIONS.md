# Decision Log

This is a lightweight record of intentional product and technical decisions. Add a dated entry when a decision changes.

## Initial decisions — 2026-09-09

### React Native and TypeScript own the product layer

React Native owns UI, product logic, application state, and future integrations. TypeScript is configured in strict mode.

### Use Expo development builds

Use Expo tooling with development builds, not Expo Go, because the spike is expected to require custom native code.

### Build for iOS first

The feasibility question concerns iPhone background behavior. Simulator use is appropriate for the scaffold, but visit detection must be validated on physical iPhones.

### Permit a focused native Swift module

Swift may own visit-detection behavior that benefits from Apple frameworks and iOS lifecycle integration. The rest of the application remains in React Native.

### Keep the spike local and minimal

The spike has no backend, AI integration, maps service, or POI provider. It collects raw evidence around hard-coded test locations before attempting classification.

### Keep manual location configuration out of the intended UX

The eventual product should infer where and when a reminder is useful. Users should not need to configure stores, geofences, radiuses, or locations.

## Native destination rotation — 2026-10-01

### Use a native rotating local window

Use native iOS significant-location-change monitoring as the low-power signal for reconsidering nearby destinations while the app is backgrounded. Native code may then install and verify a small window of system-owned `UNLocationNotificationTrigger` requests. React Native does not need to remain active, and the design must not depend on continuous GPS tracking.

When rotating destinations, install and verify the new requests before removing the old requests. Prefer fresh, independent notification and region identifiers for newly selected destinations. A failed test reused one identifier; a successful test used fresh identifiers. This supports the preference but does not prove that identifier reuse is categorically unsupported by iOS.

Destination inference, ranking, radius policy, visit classification, and the native persistence contract remain undecided. The completed spike validates the lifecycle mechanism, not those product policies.

## Server-side product boundary — 2026-10-06

### Add an independent NestJS server

Keep the Expo mobile application at the repository root and add a separate
Node project under `/server`. The two projects have independent dependencies,
lockfiles, and configuration; no workspace or monorepo framework is used.

The server owns secret-backed integrations and product logic that should not
run in or expose credentials to the mobile application. Places is the first
domain module. Its external provider sits behind an application-owned
interface so future Google-specific response types remain at the integration
boundary. Google Places, persistence, authentication, and deployment
infrastructure remain out of scope.

## Mobile place-candidate integration — 2026-10-06

### Keep transport and orchestration outside the screen

The mobile app owns a small typed `/places/candidates` client and runtime
response validation. A focused hook reacts to loaded item changes, requests
foreground location only when an exact case-insensitive `Milk` item exists,
and logs the integration result. `HomeScreen` activates the hook but does not
own networking or location logic.

The server origin is supplied through `EXPO_PUBLIC_API_BASE_URL`; this is a
non-secret address intended to be a Mac LAN URL during physical-device
development. Google credentials remain exclusively in the server environment.

Candidate state, retries, background synchronization, ranking, and native
location-notification scheduling remain intentionally undecided until this
foreground vertical slice is validated on a physical iPhone.

## Mobile item classification — 2026-10-09

### Persist classification with its owning item

The mobile application owns item classification state in the existing local
item store. Each result or failure is tied to the item text, item revision, and
taxonomy version; stale asynchronous completions are discarded when any of
those values no longer match. Retry state is persisted, automatic retries use
bounded backoff with at most three attempts, and permanent failures require an
explicit user retry.

Classification is foreground-only orchestration and remains separate from
Places discovery, geofencing, and notifications. Places requests depend only
on the item ID/text projection, so classification-only state changes do not
start discovery and classification outcomes do not select or rank places.

## Classification-driven Places contract — 2026-10-12

### Treat classifications as the only source of store categories

`POST /places/candidates` accepts only current classified items. Each item
includes its ID, revision, taxonomy version, and one or more destination
categories. The API rejects unknown categories, duplicate categories, stale
taxonomy versions, and duplicate item IDs. Places no longer derives categories
from item text.

The response is store-centric. Stores are keyed by Google Place ID and include
the IDs of every item whose categories produced that store. Category searches
are isolated: successful stores remain in the response when another category
fails. The `status` field is `complete`, `partial`, or `failed`, and
`categoryFailures` identifies each failed category with a provider-neutral
error code.

This intentionally breaks the earlier item-centric contract. Milestone 5.2
consumers must send the classified-item projection instead of item text and
read `stores`/`categoryFailures` instead of `results`/`unsupportedItemIds`.
Discovery debounce, caching, geofencing, ranking, and no-destination UI remain
out of scope; the planned discovery debounce is 400 ms.

## Places discovery lifecycle — 2026-10-12

### Coordinate foreground discovery in memory

A focused mobile coordinator owns Places discovery scheduling, cancellation,
freshness, and transient result state. Eligible classification changes clear
obsolete store associations immediately and are then coalesced with a 400 ms
debounce. Request snapshots include the canonical item IDs, revisions,
categories, taxonomy versions, and a location identity. Late completions must
match the current snapshot even when transport cancellation does not stop them.

Discovery state is separate from persisted items and distinguishes loading,
complete, partial, failed category discovery, and transport errors. Partial
responses retain their successful store-to-item associations and can be
retried explicitly; there is no automatic discovery retry loop.

Unchanged item inputs are deduplicated. Location identities reuse the previous
request anchor while movement remains under approximately 200 meters, avoiding
GPS-drift refetches without defining a durable location or cache policy.
Background and definitive-offline transitions cancel pending work and prevent
its results from applying.

Persistent caching, TTL and eviction policy, location bucketing, whether
partial retries should query only failed categories, and AsyncStorage schema
remain decisions for Milestone 5.5. Geofencing, notifications, ranking, and
no-destination UI remain out of scope.
