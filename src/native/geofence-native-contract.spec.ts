import { describe, expect, it } from 'vitest';

import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { CandidateSnapshotV1 } from '../hooks/geofence-candidate-snapshot';
import {
  buildNativeNotificationBody,
  classifyNativeRequestTransition,
  NATIVE_CANDIDATE_SCHEMA_VERSION,
  NATIVE_DUPLICATE_STORE_DISTANCE_METERS,
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
    expect(NATIVE_GEOFENCE_RADIUS_METERS).toBe(100);
    expect(NATIVE_DUPLICATE_STORE_DISTANCE_METERS).toBe(30);
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

  it('fills remaining slots with the nearest stores and keeps deterministic ties', () => {
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
    expect(selected.every((entry) => entry.fingerprintInput.radiusMeters === 100)).toBe(
      true,
    );
  });

  it('prioritizes deterministic item coverage before nearest-store fill', () => {
    const commonStores = Array.from({ length: 14 }, (_, index) =>
      store(
        `common-${index.toString().padStart(2, '0')}`,
        ['item-common'],
        {
          latitude: ANCHOR.latitude + (index + 1) * 0.001,
          longitude: ANCHOR.longitude,
        },
      ),
    );
    const specialistStores = [
      store(
        'nearer-item-a',
        ['item-a'],
        {
          latitude: ANCHOR.latitude + 0.02,
          longitude: ANCHOR.longitude,
        },
      ),
      store(
        'nearer-item-b',
        ['item-b'],
        {
          latitude: ANCHOR.latitude + 0.021,
          longitude: ANCHOR.longitude,
        },
      ),
      store(
        'farther-multi-item',
        ['item-a', 'item-b'],
        {
          latitude: ANCHOR.latitude + 0.022,
          longitude: ANCHOR.longitude,
        },
      ),
    ];
    const input = snapshot({
      items: [
        item('item-common', 'Common item'),
        item('item-a', 'Item A'),
        item('item-b', 'Item B'),
      ],
      stores: [...specialistStores, ...commonStores].reverse(),
    });

    const selected = selectNearestNativeStores(input);
    const selectedAgain = selectNearestNativeStores({
      ...input,
      stores: [...input.stores].reverse(),
    });

    expect(selected).toHaveLength(15);
    expect(selected.map((entry) => entry.placeId)).toEqual([
      ...commonStores.map((entry) => entry.placeId),
      'farther-multi-item',
    ]);
    expect(
      new Set(selected.flatMap((entry) => entry.itemIds)),
    ).toEqual(new Set(['item-common', 'item-a', 'item-b']));
    expect(selected.map((entry) => entry.placeId)).not.toContain(
      'nearer-item-a',
    );
    expect(selected.map((entry) => entry.placeId)).not.toContain(
      'nearer-item-b',
    );
    expect(selectedAgain).toEqual(selected);
  });

  it('uses distance and placeId when more distinct items exist than slots', () => {
    const items = Array.from({ length: 16 }, (_, index) =>
      item(`item-${index.toString().padStart(2, '0')}`, `Item ${index}`),
    );
    const stores = items.map((entry, index) =>
      store(`store-${index.toString().padStart(2, '0')}`, [entry.id], {
        latitude: ANCHOR.latitude + Math.floor(index / 2) * 0.01,
        longitude: ANCHOR.longitude,
      }),
    );

    const selected = selectNearestNativeStores(
      snapshot({ items, stores: [...stores].reverse() }),
    );

    expect(selected.map((entry) => entry.placeId)).toEqual(
      stores.slice(0, NATIVE_MAX_MONITORED_STORES).map((entry) => entry.placeId),
    );
    expect(new Set(selected.flatMap((entry) => entry.itemIds)).size).toBe(15);
    expect(selected.flatMap((entry) => entry.itemIds)).not.toContain('item-15');
  });

  it('collapses co-located equivalent businesses and preserves every item', () => {
    const stores = [
      {
        ...store(
          'cvs-pharmacy-place',
          ['item-milk'],
          { latitude: ANCHOR.latitude + 0.0001, longitude: ANCHOR.longitude },
        ),
        name: 'CVS Pharmacy',
      },
      {
        ...store('cvs-place', ['item-batteries'], ANCHOR),
        name: 'CVS',
      },
    ];
    const input = snapshot({
      items: [
        item('item-milk', 'Milk'),
        item('item-batteries', 'Batteries'),
      ],
      stores,
    });

    const selected = selectNearestNativeStores(input);
    const selectedFromReversedInput = selectNearestNativeStores({
      ...input,
      stores: [...stores].reverse(),
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      placeId: 'cvs-place',
      name: 'CVS',
      itemIds: ['item-batteries', 'item-milk'],
      body: 'Batteries • Milk',
      fingerprintInput: {
        placeId: 'cvs-place',
        name: 'CVS',
        radiusMeters: 100,
        items: [
          { id: 'item-batteries', revision: 1, text: 'Batteries' },
          { id: 'item-milk', revision: 1, text: 'Milk' },
        ],
      },
    });
    expect(selectedFromReversedInput).toEqual(selected);
  });

  it('keeps different businesses and equivalent businesses beyond 30 meters separate', () => {
    const selected = selectNearestNativeStores(
      snapshot({
        stores: [
          {
            ...store('cvs', ['item-milk'], ANCHOR),
            name: 'CVS Pharmacy',
          },
          {
            ...store('medicine-shoppe', ['item-milk'], ANCHOR),
            name: 'The Medicine Shoppe Pharmacy',
          },
          {
            ...store('walgreens', ['item-milk'], {
              latitude: ANCHOR.latitude + 0.001,
              longitude: ANCHOR.longitude,
            }),
            name: 'Walgreens',
          },
          {
            ...store('walgreens-pharmacy', ['item-milk'], {
              latitude: ANCHOR.latitude + 0.0014,
              longitude: ANCHOR.longitude,
            }),
            name: 'Walgreens Pharmacy',
          },
        ],
      }),
    );

    expect(selected.map((entry) => entry.placeId)).toEqual([
      'cvs',
      'medicine-shoppe',
      'walgreens',
      'walgreens-pharmacy',
    ]);
  });

  it('collapses duplicates before applying the 15-store limit', () => {
    const stores = Array.from({ length: 16 }, (_, index) => ({
      ...store(
        `store-${index.toString().padStart(2, '0')}`,
        ['item-milk'],
        {
          latitude: ANCHOR.latitude + index * 0.001,
          longitude: ANCHOR.longitude,
        },
      ),
      name: `store-${index.toString().padStart(2, '0')} Market`,
    }));
    stores.push({
      ...store('duplicate-store-00', ['item-milk'], ANCHOR),
      name: 'store-00 Market Pharmacy',
    });

    const selected = selectNearestNativeStores(snapshot({ stores }));

    expect(selected).toHaveLength(15);
    expect(selected.map((entry) => entry.placeId)).toEqual(
      Array.from(
        { length: 15 },
        (_, index) => `store-${index.toString().padStart(2, '0')}`,
      ),
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

  it('replaces pending and consumed requests whose fingerprint still uses the old radius', () => {
    const [desired] = selectNearestNativeStores(snapshot());
    const oldRadiusFingerprint = {
      ...desired.fingerprintInput,
      radiusMeters: 150,
    };

    for (const status of ['pending', 'consumed'] as const) {
      expect(
        classifyNativeRequestTransition({
          desired,
          existing: {
            status,
            isPending: status === 'pending',
            fingerprintInput: oldRadiusFingerprint,
            itemReferences: desired.itemReferences,
          },
        }),
      ).toBe('content-change');
    }
  });
});
