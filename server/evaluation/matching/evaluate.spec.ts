import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_PLACE_TYPES } from '../../src/places/google-place-types';
import {
  NEARBY_CANDIDATE_LIMIT,
  NEARBY_SEARCH_RADIUS_METERS,
} from '../../src/places/google-places.provider';
import { distanceInMeters, offsetMeters } from './distance';
import { evaluateMatchingScenarios, formatMatchingReport } from './evaluate';
import {
  DENSE_GROCERY_PLACES,
  DENSE_PHARMACY_PLACES,
  DUPLICATE_BUSINESS_PLACES,
  EMBEDDED_PHARMACY_PLACES,
  INTENTIONALLY_UNMATCHED_PRIMARY_TYPES,
  MATCHING_FIXTURE_ANCHOR,
  REQUIRED_FIXTURE_KINDS,
  type SyntheticGooglePlace,
} from './fixtures';
import {
  DUPLICATE_STORE_DISTANCE_METERS,
  GEOFENCE_RADIUS_METERS,
  MONITORED_STORE_LIMIT,
  selectMonitoredStores,
} from './monitored-selection';
import { MATCHING_EVALUATION_SCENARIOS } from './scenarios';
import { selectNearbyPlaces, simulateMatchingScenario } from './simulate';

const directory = __dirname;
const anchor = { latitude: 34.027, longitude: -118.393 };

function place(
  id: string,
  northMeters: number,
  primaryType: string,
  types: readonly string[] = [primaryType],
): SyntheticGooglePlace {
  const location = offsetMeters(MATCHING_FIXTURE_ANCHOR, northMeters);
  return {
    id,
    name: id,
    ...location,
    primaryType,
    types,
    kind: 'pharmacy',
  };
}

describe('matching evaluation fixtures', () => {
  it('covers pharmacies, convenience stores, gas-station markets, embedded pharmacies, duplicates, and dense intersections', () => {
    const kinds = new Set(
      MATCHING_EVALUATION_SCENARIOS.flatMap((scenario) =>
        scenario.places.map((entry) => entry.kind),
      ),
    );

    for (const kind of REQUIRED_FIXTURE_KINDS) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it('uses unique places and labels whose types are real Google types or the intentional gas-station exception', () => {
    const matchedTypes = new Set<string>(
      Object.values(GOOGLE_PLACE_TYPES).flat(),
    );
    const allowedTypes = new Set<string>([
      ...matchedTypes,
      ...INTENTIONALLY_UNMATCHED_PRIMARY_TYPES,
    ]);

    for (const scenario of MATCHING_EVALUATION_SCENARIOS) {
      const placeIds = scenario.places.map((entry) => entry.id);
      expect(new Set(placeIds).size).toBe(placeIds.length);

      const itemIds = scenario.items.map((entry) => entry.id);
      expect(new Set(itemIds).size).toBe(itemIds.length);

      const labels = scenario.expectations.map(
        (expected) => `${expected.itemId}\0${expected.placeId}`,
      );
      expect(new Set(labels).size).toBe(labels.length);

      for (const expected of scenario.expectations) {
        expect(itemIds).toContain(expected.itemId);
        expect(placeIds).toContain(expected.placeId);
      }

      for (const entry of scenario.places) {
        expect(allowedTypes.has(entry.primaryType)).toBe(true);
        for (const type of entry.types) {
          expect(allowedTypes.has(type)).toBe(true);
        }
      }
    }
  });

  it('places duplicate and dense fixtures on the intended sides of the production thresholds', () => {
    const ralphs = EMBEDDED_PHARMACY_PLACES.find(
      (entry) => entry.id === 'embedded-ralphs',
    );
    const ralphsPharmacy = EMBEDDED_PHARMACY_PLACES.find(
      (entry) => entry.id === 'embedded-ralphs-pharmacy',
    );
    const walgreens = DUPLICATE_BUSINESS_PLACES.find(
      (entry) => entry.id === 'duplicate-walgreens',
    );
    const walgreensPharmacy = DUPLICATE_BUSINESS_PLACES.find(
      (entry) => entry.id === 'duplicate-walgreens-pharmacy',
    );
    const cvs = DUPLICATE_BUSINESS_PLACES.find(
      (entry) => entry.id === 'duplicate-cvs',
    );
    const cvsPharmacy = DUPLICATE_BUSINESS_PLACES.find(
      (entry) => entry.id === 'duplicate-cvs-pharmacy',
    );
    const sixthGrocery = DENSE_GROCERY_PLACES[5];
    const firstPharmacy = DENSE_PHARMACY_PLACES[0];

    expect(ralphs).toBeDefined();
    expect(ralphsPharmacy).toBeDefined();
    expect(walgreens).toBeDefined();
    expect(walgreensPharmacy).toBeDefined();
    expect(cvs).toBeDefined();
    expect(cvsPharmacy).toBeDefined();
    expect(sixthGrocery).toBeDefined();
    expect(firstPharmacy).toBeDefined();
    if (
      ralphs === undefined ||
      ralphsPharmacy === undefined ||
      walgreens === undefined ||
      walgreensPharmacy === undefined ||
      cvs === undefined ||
      cvsPharmacy === undefined ||
      sixthGrocery === undefined ||
      firstPharmacy === undefined
    ) {
      return;
    }

    expect(distanceInMeters(ralphs, ralphsPharmacy)).toBeLessThan(
      DUPLICATE_STORE_DISTANCE_METERS,
    );
    expect(distanceInMeters(walgreens, walgreensPharmacy)).toBeLessThan(
      DUPLICATE_STORE_DISTANCE_METERS,
    );
    expect(distanceInMeters(cvs, cvsPharmacy)).toBeGreaterThan(
      DUPLICATE_STORE_DISTANCE_METERS,
    );
    expect(
      distanceInMeters(MATCHING_FIXTURE_ANCHOR, sixthGrocery),
    ).toBeLessThan(distanceInMeters(MATCHING_FIXTURE_ANCHOR, firstPharmacy));
  });
});

describe('synthetic nearby search', () => {
  it('keeps the five nearest primary-type matches and leaves secondary types unmatched', () => {
    const pharmacies = Array.from({ length: 6 }, (_, index) =>
      place(`pharmacy-${index + 1}`, (index + 1) * 100, 'drugstore'),
    );
    const chevron = place('chevron', 50, 'gas_station', [
      'gas_station',
      'convenience_store',
    ]);
    const embedded = place('target', 80, 'department_store', [
      'department_store',
      'pharmacy',
    ]);
    const distant = place('distant-cvs', 4_000, 'pharmacy');
    const catalog = [...pharmacies, chevron, embedded, distant];

    const pharmacySearch = selectNearbyPlaces(
      catalog,
      MATCHING_FIXTURE_ANCHOR,
      ['pharmacy'],
    );
    expect(pharmacySearch.returned.map((entry) => entry.id)).toEqual([
      'pharmacy-1',
      'pharmacy-2',
      'pharmacy-3',
      'pharmacy-4',
      'pharmacy-5',
    ]);
    expect(pharmacySearch.capped.map((entry) => entry.id)).toEqual([
      'pharmacy-6',
    ]);

    expect(
      selectNearbyPlaces(catalog, MATCHING_FIXTURE_ANCHOR, [
        'convenience-store',
      ]).returned,
    ).toEqual([]);
    expect(
      selectNearbyPlaces(catalog, MATCHING_FIXTURE_ANCHOR, ['pharmacy'])
        .returned,
    ).not.toContainEqual(expect.objectContaining({ id: 'target' }));
    expect(
      selectNearbyPlaces(catalog, MATCHING_FIXTURE_ANCHOR, ['pharmacy'])
        .returned,
    ).not.toContainEqual(expect.objectContaining({ id: 'distant-cvs' }));
    expect(NEARBY_CANDIDATE_LIMIT).toBe(5);
    expect(NEARBY_SEARCH_RADIUS_METERS).toBe(3218.688);
  });
});

describe('monitored store selection', () => {
  it('follows the portable item-aware and 30 meter duplicate contract', () => {
    const collapsed = selectMonitoredStores({
      anchor,
      stores: [
        {
          placeId: 'cvs-pharmacy-place',
          name: 'CVS Pharmacy',
          location: {
            latitude: anchor.latitude + 0.0001,
            longitude: anchor.longitude,
          },
          itemIds: ['item-milk'],
        },
        {
          placeId: 'cvs-place',
          name: 'CVS',
          location: anchor,
          itemIds: ['item-batteries'],
        },
      ],
    });
    expect(collapsed.monitored).toHaveLength(1);
    expect(collapsed.monitored[0]).toMatchObject({
      placeId: 'cvs-place',
      name: 'CVS',
      itemIds: ['item-batteries', 'item-milk'],
    });
    expect(collapsed.collapsed).toEqual([
      {
        droppedPlaceId: 'cvs-pharmacy-place',
        representativePlaceId: 'cvs-place',
      },
    ]);

    const separate = selectMonitoredStores({
      anchor,
      stores: [
        {
          placeId: 'cvs',
          name: 'CVS Pharmacy',
          location: anchor,
          itemIds: ['item-milk'],
        },
        {
          placeId: 'medicine-shoppe',
          name: 'The Medicine Shoppe Pharmacy',
          location: anchor,
          itemIds: ['item-milk'],
        },
        {
          placeId: 'walgreens',
          name: 'Walgreens',
          location: {
            latitude: anchor.latitude + 0.001,
            longitude: anchor.longitude,
          },
          itemIds: ['item-milk'],
        },
        {
          placeId: 'walgreens-pharmacy',
          name: 'Walgreens Pharmacy',
          location: {
            latitude: anchor.latitude + 0.0014,
            longitude: anchor.longitude,
          },
          itemIds: ['item-milk'],
        },
      ],
    });
    expect(separate.monitored.map((store) => store.placeId)).toEqual([
      'cvs',
      'medicine-shoppe',
      'walgreens',
      'walgreens-pharmacy',
    ]);

    const crowded = Array.from({ length: 18 }, (_, index) => {
      const row = Math.floor(index / 2);
      return {
        placeId: `store-${index.toString().padStart(2, '0')}`,
        name: `store-${index.toString().padStart(2, '0')} Market`,
        location: {
          latitude: anchor.latitude + row * 0.01,
          longitude: anchor.longitude,
        },
        itemIds: ['item-milk'],
      };
    });
    expect(
      selectMonitoredStores({
        anchor,
        stores: [...crowded].reverse(),
      }).monitored.map((store) => store.placeId),
    ).toEqual(
      crowded.slice(0, MONITORED_STORE_LIMIT).map((store) => store.placeId),
    );

    const withDuplicate = crowded.slice(0, 16).map((store) => ({ ...store }));
    withDuplicate.push({
      placeId: 'duplicate-store-00',
      name: 'store-00 Market Pharmacy',
      location: anchor,
      itemIds: ['item-milk'],
    });
    const afterCollapse = selectMonitoredStores({
      anchor,
      stores: withDuplicate,
    });
    expect(afterCollapse.monitored).toHaveLength(15);
    expect(afterCollapse.monitored.map((store) => store.placeId)).toEqual(
      Array.from(
        { length: 15 },
        (_, index) => `store-${index.toString().padStart(2, '0')}`,
      ),
    );
    expect(MONITORED_STORE_LIMIT).toBe(15);
    expect(DUPLICATE_STORE_DISTANCE_METERS).toBe(30);
    expect(GEOFENCE_RADIUS_METERS).toBe(100);
  });

  it('covers distinct items before filling remaining slots by distance', () => {
    const commonStores = Array.from({ length: 15 }, (_, index) => ({
      placeId: `common-${index.toString().padStart(2, '0')}`,
      name: `Common ${index}`,
      location: offsetMeters(anchor, (index + 1) * 100),
      itemIds: ['common-item'],
    }));
    const selected = selectMonitoredStores({
      anchor,
      stores: [
        ...commonStores,
        {
          placeId: 'auto-parts',
          name: 'Auto Parts',
          location: offsetMeters(anchor, 2_000),
          itemIds: ['wiper-blades'],
        },
        {
          placeId: 'pet-store',
          name: 'Pet Store',
          location: offsetMeters(anchor, 2_200),
          itemIds: ['dog-food'],
        },
      ].reverse(),
    });

    expect(selected.monitored.map((store) => store.placeId)).toEqual([
      ...commonStores.slice(0, 13).map((store) => store.placeId),
      'auto-parts',
      'pet-store',
    ]);
    expect(
      new Set(selected.monitored.flatMap((store) => store.itemIds)),
    ).toEqual(new Set(['common-item', 'wiper-blades', 'dog-food']));
    expect(selected.excluded.map((store) => store.placeId)).toEqual([
      'common-13',
      'common-14',
    ]);
  });
});

describe('matching evaluation baseline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records current matching quality, including known misses and false positives', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('matching evaluation must stay offline');
    });

    const report = await evaluateMatchingScenarios(
      MATCHING_EVALUATION_SCENARIOS,
    );
    const repeated = await evaluateMatchingScenarios(
      MATCHING_EVALUATION_SCENARIOS,
    );

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(report));
    expect(report.pipeline).toEqual({
      nearbyCandidateLimit: 5,
      nearbyRadiusMeters: 3218.688,
      fieldMask:
        'places.id,places.displayName,places.location,places.businessStatus,places.pureServiceAreaBusiness',
      maxMonitoredStores: 15,
      duplicateDistanceMeters: 30,
      geofenceRadiusMeters: 100,
      geofenceFiltersMatches: false,
    });
    expect(
      report.scenarios.map((scenario) => [
        scenario.id,
        scenario.truePositives,
        scenario.falsePositives,
        scenario.falseNegatives,
        scenario.suppressedFalsePositives,
        scenario.unexpectedAssociations.length,
      ]),
    ).toEqual([
      ['pharmacy-broadcast', 11, 2, 0, 0, 0],
      ['gas-station-markets', 7, 2, 1, 0, 0],
      ['embedded-pharmacies', 8, 1, 1, 0, 0],
      ['duplicate-businesses', 4, 2, 0, 0, 0],
      ['dense-intersection', 25, 0, 4, 0, 0],
    ]);
    expect(report.totals).toMatchObject({
      scenarios: 5,
      truePositives: 55,
      falsePositives: 7,
      falseNegatives: 6,
      suppressedFalsePositives: 0,
      unexpectedAssociations: 0,
    });
    expect(report.totals.precision).toBeCloseTo(55 / 62);
    expect(report.totals.recall).toBeCloseTo(55 / 61);
    expect(report.totals.precision).toBeLessThan(1);
    expect(report.totals.recall).toBeLessThan(1);

    for (const scenario of report.scenarios) {
      for (const association of scenario.associations) {
        if (association.limitation === null) {
          expect(association.outcome).toBe('true-positive');
          expect(association.cause).toBeNull();
          continue;
        }

        expect(association.cause).toBe(association.limitation);
        expect(association.outcome).toBe(
          association.judgment === 'reasonable'
            ? 'false-negative'
            : 'false-positive',
        );
      }
    }

    const dense = report.scenarios.find(
      (scenario) => scenario.id === 'dense-intersection',
    );
    expect(dense?.monitoredStoreCount).toBe(15);
    expect(dense?.excludedPlaceIds).toEqual([
      'dense-pharmacy-04',
      'dense-pharmacy-05',
      'dense-department',
    ]);
    expect(dense?.searchCount).toBe(6);
    expect(
      dense?.associations.filter(
        (association) =>
          association.itemId === 'wiper-blades' &&
          association.outcome === 'true-positive',
      ),
    ).toHaveLength(1);
    expect(
      dense?.associations.filter(
        (association) =>
          association.itemId === 'dog-food' &&
          association.outcome === 'true-positive',
      ),
    ).toHaveLength(1);
    expect(
      dense?.associations.filter(
        (association) =>
          association.itemId === 'batteries' &&
          association.outcome === 'false-negative' &&
          association.placeId.startsWith('dense-pharmacy-'),
      ),
    ).toHaveLength(2);
    expect(
      dense?.associations.some(
        (association) =>
          association.itemId === 'milk' &&
          association.outcome === 'true-positive',
      ),
    ).toBe(true);

    const denseScenario = MATCHING_EVALUATION_SCENARIOS.find(
      (scenario) => scenario.id === 'dense-intersection',
    );
    expect(denseScenario).toBeDefined();
    if (denseScenario === undefined) {
      return;
    }
    const denseSimulation = await simulateMatchingScenario(denseScenario);
    expect(denseSimulation.monitored.map((store) => store.placeId)).toEqual([
      'dense-grocery-01',
      'dense-convenience-01',
      'dense-grocery-02',
      'dense-convenience-02',
      'dense-grocery-03',
      'dense-convenience-03',
      'dense-grocery-04',
      'dense-convenience-04',
      'dense-grocery-05',
      'dense-convenience-05',
      'dense-pharmacy-01',
      'dense-pharmacy-02',
      'dense-pharmacy-03',
      'dense-auto-parts',
      'dense-pet-store',
    ]);
    expect(
      new Set(denseSimulation.monitored.flatMap((store) => store.itemIds)),
    ).toEqual(new Set(['milk', 'batteries', 'wiper-blades', 'dog-food']));

    const embedded = report.scenarios.find(
      (scenario) => scenario.id === 'embedded-pharmacies',
    );
    expect(embedded?.collapsed).toEqual([
      {
        droppedPlaceId: 'embedded-ralphs-pharmacy',
        representativePlaceId: 'embedded-ralphs',
      },
    ]);

    const duplicates = report.scenarios.find(
      (scenario) => scenario.id === 'duplicate-businesses',
    );
    expect(duplicates?.collapsed).toEqual([
      {
        droppedPlaceId: 'duplicate-walgreens-pharmacy',
        representativePlaceId: 'duplicate-walgreens',
      },
    ]);
    expect(duplicates?.monitoredStoreCount).toBe(3);

    expect(report.priorities.map((priority) => priority.id)).toEqual([
      'monitored-15-cap',
      'embedded-pharmacy-secondary-type',
      'primary-type-filter',
      'per-category-candidate-cap',
      'category-broadcast',
      'duplicate-beyond-30m',
    ]);

    const text = formatMatchingReport(report);
    expect(text).toContain('Correct matches: 55');
    expect(text).toContain('False positives: 7');
    expect(text).toContain('False negatives: 6');
    expect(text).toContain('Milestone 7B priorities:');
    expect(text).toContain('wiper blades');
    expect(text).toContain('Chevron ExtraMile');
  });

  it('tracks the production search request and geofence constants', () => {
    const provider = readFileSync(
      resolve(directory, '../../src/places/google-places.provider.ts'),
      'utf8',
    );
    const contract = readFileSync(
      resolve(directory, '../../../src/native/geofence-native-contract.ts'),
      'utf8',
    );
    const swift = readFileSync(
      resolve(
        directory,
        '../../../modules/there-you-go-location-notification/ios/ThereYouGoLocationNotificationReconciler.swift',
      ),
      'utf8',
    );

    expect(provider).toContain('includedPrimaryTypes');
    expect(provider).toContain("rankPreference: 'DISTANCE'");
    expect(provider).toContain('maxResultCount: NEARBY_CANDIDATE_LIMIT');
    expect(provider).toContain('radius: NEARBY_SEARCH_RADIUS_METERS');
    expect(provider).toContain(
      'places.id,places.displayName,places.location,places.businessStatus,places.pureServiceAreaBusiness',
    );
    expect(contract).toContain(
      'export const NATIVE_MAX_MONITORED_STORES = 15;',
    );
    expect(contract).toContain(
      'export const NATIVE_DUPLICATE_STORE_DISTANCE_METERS = 30;',
    );
    expect(contract).toContain(
      'export const NATIVE_GEOFENCE_RADIUS_METERS = 100;',
    );
    expect(swift).toContain('static let maximumSelectedStores = 15');
    expect(swift).toContain('static let duplicateStoreDistanceMeters = 30.0');
    expect(swift).toContain('static let radiusMeters = 100.0');
  });
});
