import { describe, expect, it } from 'vitest';

import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { CandidateSnapshotV1 } from '../hooks/geofence-candidate-snapshot';
import {
  buildNativeNotificationBody,
  classifyNativeRequestTransition,
  NATIVE_CANDIDATE_SCHEMA_VERSION,
  NATIVE_GEOFENCE_RADIUS_METERS,
  NATIVE_MANAGED_IDENTIFIER_PREFIX,
  NATIVE_MAX_LOCATION_TRIGGERS,
  NATIVE_MAX_MONITORED_STORES,
  selectNearestNativeStores,
  toNativeCandidateSnapshot,
  validateNativeCandidateSnapshot,
  type NativeContractSnapshot,
} from './geofence-native-contract';

const ANCHOR = { latitude: 34.027, longitude: -118.393 };

function item(
  id: string,
  text: string,
  categories: NativeContractSnapshot['items'][number]['categories'] = [
    'grocery-store',
  ],
) {
  return {
    id,
    revision: 1,
    text,
    categories,
  };
}

function store(
  placeId: string,
  itemIds: string[],
  location = { latitude: 34.03, longitude: -118.39 },
) {
  return {
    placeId,
    name: `${placeId} Market`,
    location,
    itemIds,
  };
}

function snapshot(
  overrides: Partial<NativeContractSnapshot> = {},
): NativeContractSnapshot {
  return {
    schemaVersion: NATIVE_CANDIDATE_SCHEMA_VERSION,
    generatedAt: '2026-10-13T20:00:00.000Z',
    discoveryAnchor: ANCHOR,
    items: [item('item-milk', 'Milk')],
    stores: [store('whole-foods', ['item-milk'])],
    ...overrides,
  };
}

describe('native geofence contract', () => {
  it('accepts a Milestone 6B.1 candidate snapshot without extra fields', () => {
    const candidate: CandidateSnapshotV1 = {
      schemaVersion: 1,
      generatedAt: '2026-10-13T20:00:00.000Z',
      discoveryAnchor: ANCHOR,
      items: [
        {
          id: 'item-milk',
          revision: 1,
          text: 'Milk',
          categories: ['grocery-store'],
        },
      ],
      stores: [
        {
          placeId: 'whole-foods',
          name: 'Whole Foods',
          location: { latitude: 34.03, longitude: -118.39 },
          itemIds: ['item-milk'],
        },
      ],
    };

    expect(toNativeCandidateSnapshot(candidate)).toMatchObject({
      schemaVersion: 1,
      items: [{ id: 'item-milk', revision: 1, text: 'Milk' }],
      stores: [{ placeId: 'whole-foods', itemIds: ['item-milk'] }],
    });
    expect(DESTINATION_TAXONOMY_VERSION).toBe(1);
    expect(NATIVE_GEOFENCE_RADIUS_METERS).toBe(150);
    expect(NATIVE_MAX_MONITORED_STORES).toBe(15);
    expect(NATIVE_MAX_LOCATION_TRIGGERS).toBe(20);
    expect(NATIVE_MANAGED_IDENTIFIER_PREFIX).toBe('tyg.arrival.v1.');
  });

  it('rejects malformed snapshots without implying prior state should change', () => {
    expect(() =>
      validateNativeCandidateSnapshot(snapshot({ schemaVersion: 2 })),
    ).toThrow(/schemaVersion/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({ generatedAt: 'not-a-timestamp' }),
      ),
    ).toThrow(/generatedAt/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({ generatedAt: '2026-10-13T20:00:00Z' }),
      ),
    ).toThrow(/generatedAt/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({ generatedAt: '10/13/2026 20:00:00' }),
      ),
    ).toThrow(/generatedAt/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({ generatedAt: '2026-02-30T20:00:00.000Z' }),
      ),
    ).toThrow(/generatedAt/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({
          discoveryAnchor: { latitude: 91, longitude: 0 },
        }),
      ),
    ).toThrow(/discoveryAnchor/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({
          items: [item('item-milk', 'Milk'), item('item-milk', 'Bread')],
        }),
      ),
    ).toThrow(/unique/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({
          items: [{ ...item('item-milk', 'Milk'), revision: 0 }],
        }),
      ),
    ).toThrow(/revision/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({
          stores: [store('whole-foods', ['missing-item'])],
        }),
      ),
    ).toThrow(/unknown item/);
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({
          stores: [store('whole-foods', [])],
        }),
      ),
    ).toThrow(/at least one item/);
  });

  it('accepts an authoritative empty snapshot', () => {
    expect(
      validateNativeCandidateSnapshot(
        snapshot({
          items: [],
          stores: [],
        }),
      ).stores,
    ).toEqual([]);
  });

  it('selects the 15 nearest eligible stores and keeps deterministic ties', () => {
    const items = [item('item-milk', 'Milk')];
    const stores = Array.from({ length: 18 }, (_, index) => {
      const row = Math.floor(index / 2);
      return store(`store-${index.toString().padStart(2, '0')}`, ['item-milk'], {
        latitude: ANCHOR.latitude + row * 0.01,
        longitude: ANCHOR.longitude,
      });
    });

    const selected = selectNearestNativeStores(
      snapshot({
        items,
        stores: [...stores].reverse(),
      }),
    );

    expect(selected).toHaveLength(15);
    expect(selected.map((entry) => entry.placeId)).toEqual([
      'store-00',
      'store-01',
      'store-02',
      'store-03',
      'store-04',
      'store-05',
      'store-06',
      'store-07',
      'store-08',
      'store-09',
      'store-10',
      'store-11',
      'store-12',
      'store-13',
      'store-14',
    ]);
    expect(selected.every((entry) => entry.fingerprintInput.radiusMeters === 150)).toBe(
      true,
    );
  });

  it('rejects stores whose item associations are no longer eligible', () => {
    expect(() =>
      validateNativeCandidateSnapshot(
        snapshot({
          items: [item('item-batteries', 'Batteries')],
          stores: [
            store('empty-store', ['item-milk']),
            store('hardware', ['item-batteries']),
          ],
        }),
      ),
    ).toThrow(/unknown item/);

    const selected = selectNearestNativeStores(
      snapshot({
        items: [item('item-batteries', 'Batteries')],
        stores: [store('hardware', ['item-batteries'])],
      }),
    );
    expect(selected.map((entry) => entry.placeId)).toEqual(['hardware']);
  });

  it('renders one concise notification per store with every associated item id', () => {
    const selected = selectNearestNativeStores(
      snapshot({
        items: [
          item('item-z', 'Zucchini'),
          item('item-a', 'Almonds'),
          item('item-b', 'Batteries'),
          item('item-c', 'Coffee'),
        ],
        stores: [
          store('whole-foods', [
            'item-z',
            'item-a',
            'item-b',
            'item-c',
          ]),
        ],
      }),
    );

    expect(selected[0].title).toBe('At whole-foods Market');
    expect(selected[0].itemIds).toEqual([
      'item-a',
      'item-b',
      'item-c',
      'item-z',
    ]);
    expect(selected[0].body).toBe('Almonds • Batteries • Coffee • +1 more');
    expect(buildNativeNotificationBody(['Milk', 'Batteries'])).toBe(
      'Milk • Batteries',
    );
  });

  it('classifies lifecycle, content, consumed, and unchanged transitions', () => {
    const [desired] = selectNearestNativeStores(snapshot());

    expect(
      classifyNativeRequestTransition({
        desired,
      }),
    ).toBe('add');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: true,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('unchanged');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'consumed',
          isPending: false,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('consumed-same-fingerprint');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: false,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('consumed-same-fingerprint');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: true,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: [{ id: 'item-milk', revision: 1 }],
        },
      }),
    ).toBe('unchanged');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: true,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: [
            { id: 'item-milk', revision: 1 },
            { id: 'item-batteries', revision: 1 },
          ],
        },
      }),
    ).toBe('lifecycle-invalid');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: true,
          fingerprintInput: {
            ...desired.fingerprintInput,
            name: 'Old Name',
          },
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('content-change');
  });
});
