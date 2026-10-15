# Store-to-item matching evaluation

This directory scores the current store-to-item pipeline on deterministic
synthetic Google Places catalogs. It does not call Google or Gemini, and it
does not change discovery, classification, or geofence behavior.

The fixture set originated with the Milestone 7A baseline. The checks record
current matching quality, including known misses and false positives. Update
the labeled expectations when production matching changes.

## Pipeline under test

1. `PlacesService` searches each distinct destination category once.
2. Synthetic Nearby Search keeps places whose primary type is in that
   category's `GOOGLE_PLACE_TYPES` list, inside the production radius, ranked
   by distance, capped at the production candidate limit. Secondary types are
   fixture metadata. The production field mask requests id, name, location,
   business status, and pure service-area status, then drops places explicitly
   marked closed or service-area-only. Synthetic search still admits by
   primary type only.
3. Every returned store receives every item id associated with that category.
4. Duplicate business names within 30 meters collapse, then greedy selection
   covers the most distinct items it can before filling the remaining 15 slots
   with the nearest stores. The 100 meter geofence is the region later
   installed on a monitored store.

Selection mirrors the portable native contract and the Swift constants. The
runtime owners remain `selectNearestNativeStores` and
`ThereYouGoLocationNotificationReconciler`.

## Scenarios

- `pharmacy-broadcast`: retail pharmacies, a drugstore, grocery, department,
  and convenience matches, plus a dispensing-only outpatient pharmacy that
  inherits OTC items and greeting cards.
- `gas-station-markets`: a dedicated convenience store, fuel markets typed as
  `convenience_store`, and a Chevron market whose primary type is
  `gas_station`.
- `embedded-pharmacies`: a supermarket with a separate in-store pharmacy
  listing, and a department store whose pharmacy exists only as a secondary
  type.
- `duplicate-businesses`: one pair inside the 30 meter collapse window and
  one pair outside it.
- `dense-intersection`: item-aware selection preserves the only auto-parts
  store for wiper blades and the only pet store for dog food, displacing two
  farther pharmacies. A sixth grocery is still dropped by the five-result
  category cap.

Reasonable labels are matches a reminder should keep. False-positive labels
are associations the current category rules produce that a reminder should
skip. A limitation on a reasonable label predicts a miss.

## Run

From `/server`:

```bash
npm run eval:matching
```

Add `--json` for the machine-readable report. `npm test` runs the same
baseline and checks that the measured associations still match the labeled
7A results.
