import { describe, expect, it } from 'vitest';

import type {
  PlaceCandidatesResponse,
  PlaceStore,
} from '../api/places';
import {
  DESTINATION_TAXONOMY_VERSION,
  type DestinationCategory,
} from '../models/Classification';
import {
  completeItem,
  deleteItem,
  undoItemCompletion,
  updateItemText,
} from '../models/item-transitions';
import type { Item } from '../models/Item';
import {
  buildCandidateSnapshotV1,
  CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
  GEOFENCE_RADIUS_METERS,
  sanitizeCandidateSnapshotV1,
  type CandidateCoordinatesV1,
  type CandidateSnapshotV1,
} from './geofence-candidate-snapshot';
import {
  createPlaceRequestItemsSignature,
  parsePlaceRequestItemsSignature,
} from './place-item-projection';

const ANCHOR: CandidateCoordinatesV1 = {
  latitude: 34.027,
  longitude: -118.393,
};
const GENERATED_AT = '2026-10-13T20:00:00.000Z';
const LATER = '2026-10-13T20:05:00.000Z';

function classifiedItem(
  id: string,
  text: string,
  categories: [DestinationCategory, ...DestinationCategory[]],
  revision = 1,
): Item {
  return {
    id,
    text,
    createdAt: '2026-10-13T19:00:00.000Z',
    updatedAt: '2026-10-13T19:00:00.000Z',
    revision,
    classification: {
      status: 'current',
      sourceRevision: revision,
      sourceText: text,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      result: {
        outcome: 'classified',
        categories,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    },
  };
}

function requestItems(items: readonly Item[]) {
  return parsePlaceRequestItemsSignature(
    createPlaceRequestItemsSignature(items),
  );
}

function store(
  placeId: string,
  itemIds: string[],
  overrides: Partial<PlaceStore> = {},
): PlaceStore {
  return {
    placeId,
    name: `${placeId} Store`,
    location: {
      latitude: 34.03,
      longitude: -118.39,
    },
    itemIds,
    ...overrides,
  };
}

function response(
  status: PlaceCandidatesResponse['status'],
  stores: PlaceStore[],
): PlaceCandidatesResponse {
  return {
    status,
    stores,
    categoryFailures:
      status === 'complete'
        ? []
        : [{ category: 'grocery-store', code: 'provider-error' }],
  };
}

function buildComplete(
  items: readonly Item[],
  stores: PlaceStore[],
  previousSnapshot?: CandidateSnapshotV1,
): CandidateSnapshotV1 {
  return buildCandidateSnapshotV1({
    generatedAt: GENERATED_AT,
    items,
    previousSnapshot,
    discovery: {
      anchor: ANCHOR,
      requestItems: requestItems(items),
      response: response('complete', stores),
    },
  });
}

describe('geofence candidate snapshots', () => {
  it('builds a versioned canonical pool with multiple items per store', () => {
    const milk = classifiedItem('item-milk', 'Milk', [
      'convenience-store',
      'grocery-store',
    ]);
    const batteries = classifiedItem(
      'item-batteries',
      'Batteries',
      ['hardware-store'],
    );

    const snapshot = buildComplete(
      [milk, batteries],
      [
        store('whole-foods', ['item-milk', 'item-batteries', 'item-milk'], {
          name: 'Whole Foods',
        }),
        store('ace', ['item-batteries']),
        store('whole-foods', ['item-batteries'], {
          name: 'Whole Foods',
        }),
      ],
    );

    expect(CANDIDATE_SNAPSHOT_SCHEMA_VERSION).toBe(1);
    expect(GEOFENCE_RADIUS_METERS).toBe(100);
    expect(snapshot).toEqual({
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      discoveryAnchor: ANCHOR,
      items: [
        {
          id: 'item-batteries',
          revision: 1,
          text: 'Batteries',
          categories: ['hardware-store'],
        },
        {
          id: 'item-milk',
          revision: 1,
          text: 'Milk',
          categories: ['grocery-store', 'convenience-store'],
        },
      ],
      stores: [
        {
          placeId: 'ace',
          name: 'ace Store',
          location: {
            latitude: 34.03,
            longitude: -118.39,
          },
          itemIds: ['item-batteries'],
        },
        {
          placeId: 'whole-foods',
          name: 'Whole Foods',
          location: {
            latitude: 34.03,
            longitude: -118.39,
          },
          itemIds: ['item-batteries', 'item-milk'],
        },
      ],
    });
  });

  it('is deterministic across item, request, store, category, and association order', () => {
    const milk = classifiedItem('item-milk', 'Milk', [
      'convenience-store',
      'grocery-store',
    ]);
    const batteries = classifiedItem(
      'item-batteries',
      'Batteries',
      ['hardware-store'],
    );
    const stores = [
      store('whole-foods', ['item-milk', 'item-batteries']),
      store('ace', ['item-batteries']),
    ];
    const first = buildComplete([milk, batteries], stores);

    const reorderedMilk = classifiedItem('item-milk', 'Milk', [
      'grocery-store',
      'convenience-store',
    ]);
    const reorderedItems = [batteries, reorderedMilk];
    const second = buildCandidateSnapshotV1({
      generatedAt: GENERATED_AT,
      items: reorderedItems,
      discovery: {
        anchor: { ...ANCHOR },
        requestItems: [...requestItems(reorderedItems)].reverse(),
        response: response(
          'complete',
          [...stores]
            .reverse()
            .map((candidate) => ({
              ...candidate,
              itemIds: [...candidate.itemIds].reverse(),
            })),
        ),
      },
    });

    expect(second).toEqual(first);
  });

  it('excludes completed, pending, failed, stale, and non-destination items', () => {
    const eligible = classifiedItem(
      'item-eligible',
      'Milk',
      ['grocery-store'],
    );
    const completed = {
      ...classifiedItem('item-completed', 'Bread', ['grocery-store']),
      completedAt: LATER,
    };
    const pending: Item = {
      ...classifiedItem('item-pending', 'Soap', ['pharmacy']),
      classification: {
        status: 'pending',
        sourceRevision: 1,
        sourceText: 'Soap',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 0,
        nextAttemptAt: null,
      },
    };
    const failed: Item = {
      ...classifiedItem('item-failed', 'Bandages', ['pharmacy']),
      classification: {
        status: 'failed',
        sourceRevision: 1,
        sourceText: 'Bandages',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        attemptCount: 3,
        nextAttemptAt: null,
        retryable: false,
        failureKind: 'server',
      },
    };
    const stale = {
      ...classifiedItem('item-stale', 'Nails', ['hardware-store']),
      revision: 2,
    };
    const noDestination: Item = {
      ...classifiedItem('item-none', 'Call Mom', ['grocery-store']),
      classification: {
        status: 'current',
        sourceRevision: 1,
        sourceText: 'Call Mom',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        result: {
          outcome: 'no-destination',
          categories: [],
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        },
      },
    };
    const items = [
      eligible,
      completed,
      pending,
      failed,
      stale,
      noDestination,
    ];

    const snapshot = buildComplete(items, [
      store('market', items.map((item) => item.id)),
    ]);

    expect(snapshot.items.map((item) => item.id)).toEqual(['item-eligible']);
    expect(snapshot.stores[0].itemIds).toEqual(['item-eligible']);
  });

  it('sanitizes a multi-item store immediately after completion', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const batteries = classifiedItem(
      'item-batteries',
      'Batteries',
      ['hardware-store'],
    );
    const items = [milk, batteries];
    const staleRequestItems = requestItems(items);
    const stores = [
      store('whole-foods', ['item-milk', 'item-batteries']),
    ];
    const snapshot = buildComplete(items, stores);
    const completed = completeItem(items, 'item-milk', LATER);

    const sanitized = sanitizeCandidateSnapshotV1({
      generatedAt: LATER,
      items: completed,
      snapshot,
    });
    const afterStaleResponse = buildCandidateSnapshotV1({
      generatedAt: LATER,
      items: completed,
      previousSnapshot: snapshot,
      discovery: {
        anchor: ANCHOR,
        requestItems: staleRequestItems,
        response: response('complete', stores),
      },
    });

    expect(sanitized.items.map((item) => item.id)).toEqual([
      'item-batteries',
    ]);
    expect(sanitized.stores).toEqual([
      expect.objectContaining({ itemIds: ['item-batteries'] }),
    ]);
    expect(afterStaleResponse).toEqual(sanitized);
  });

  it('removes a store when lifecycle sanitization removes its last item', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const snapshot = buildComplete([milk], [
      store('whole-foods', ['item-milk']),
    ]);
    const completed = completeItem([milk], 'item-milk', LATER);

    const sanitized = sanitizeCandidateSnapshotV1({
      generatedAt: LATER,
      items: completed,
      snapshot,
    });

    expect(sanitized.items).toEqual([]);
    expect(sanitized.stores).toEqual([]);
  });

  it('does not restore a completed item on undo until fresh discovery', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const initial = buildComplete([milk], [
      store('whole-foods', ['item-milk']),
    ]);
    const completed = completeItem([milk], 'item-milk', LATER);
    const afterCompletion = sanitizeCandidateSnapshotV1({
      generatedAt: LATER,
      items: completed,
      snapshot: initial,
    });
    const restoredItems = undoItemCompletion(completed, 'item-milk');

    const beforeDiscovery = sanitizeCandidateSnapshotV1({
      generatedAt: '2026-10-13T20:06:00.000Z',
      items: restoredItems,
      snapshot: afterCompletion,
    });
    const afterFreshDiscovery = buildComplete(restoredItems, [
      store('whole-foods', ['item-milk']),
    ]);

    expect(beforeDiscovery.items).toEqual([]);
    expect(beforeDiscovery.stores).toEqual([]);
    expect(afterFreshDiscovery.items.map((item) => item.id)).toEqual([
      'item-milk',
    ]);
    expect(afterFreshDiscovery.stores[0].itemIds).toEqual(['item-milk']);
  });

  it('does not apply a stale complete response after an edit', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const batteries = classifiedItem(
      'item-batteries',
      'Batteries',
      ['hardware-store'],
    );
    const items = [milk, batteries];
    const stores = [
      store('whole-foods', ['item-milk', 'item-batteries']),
    ];
    const previousSnapshot = buildComplete(items, stores);
    const staleRequestItems = requestItems(items);
    const edited = updateItemText(items, 'item-milk', 'Oat milk', LATER);

    const snapshot = buildCandidateSnapshotV1({
      generatedAt: LATER,
      items: edited,
      previousSnapshot,
      discovery: {
        anchor: ANCHOR,
        requestItems: staleRequestItems,
        response: response('complete', stores),
      },
    });

    expect(snapshot.items.map((item) => item.id)).toEqual([
      'item-batteries',
    ]);
    expect(snapshot.stores[0].itemIds).toEqual(['item-batteries']);
  });

  it('does not apply a stale revision after an edited item is reclassified', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const previousSnapshot = buildComplete([milk], [
      store('whole-foods', ['item-milk']),
    ]);
    const staleRequestItems = requestItems([milk]);
    const reclassified = classifiedItem(
      'item-milk',
      'Oat milk',
      ['grocery-store'],
      2,
    );

    const snapshot = buildCandidateSnapshotV1({
      generatedAt: LATER,
      items: [reclassified],
      previousSnapshot,
      discovery: {
        anchor: ANCHOR,
        requestItems: staleRequestItems,
        response: response('complete', [
          store('whole-foods', ['item-milk']),
        ]),
      },
    });

    expect(snapshot.items).toEqual([]);
    expect(snapshot.stores).toEqual([]);
  });

  it('sanitizes deletion immediately and ignores its stale response', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const batteries = classifiedItem(
      'item-batteries',
      'Batteries',
      ['hardware-store'],
    );
    const items = [milk, batteries];
    const stores = [
      store('whole-foods', ['item-milk', 'item-batteries']),
    ];
    const previousSnapshot = buildComplete(items, stores);
    const staleRequestItems = requestItems(items);
    const remainingItems = deleteItem(items, 'item-milk');

    const sanitized = sanitizeCandidateSnapshotV1({
      generatedAt: LATER,
      items: remainingItems,
      snapshot: previousSnapshot,
    });
    const afterStaleResponse = buildCandidateSnapshotV1({
      generatedAt: LATER,
      items: remainingItems,
      previousSnapshot,
      discovery: {
        anchor: ANCHOR,
        requestItems: staleRequestItems,
        response: response('complete', stores),
      },
    });

    expect(sanitized.stores[0].itemIds).toEqual(['item-batteries']);
    expect(afterStaleResponse).toEqual(sanitized);
  });

  it.each(['partial', 'failed'] as const)(
    'retains and sanitizes the previous valid pool on %s discovery',
    (status) => {
      const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
      const batteries = classifiedItem(
        'item-batteries',
        'Batteries',
        ['hardware-store'],
      );
      const previousSnapshot = buildComplete([milk, batteries], [
        store('whole-foods', ['item-milk', 'item-batteries']),
      ]);
      const completed = completeItem(
        [milk, batteries],
        'item-milk',
        LATER,
      );

      const snapshot = buildCandidateSnapshotV1({
        generatedAt: LATER,
        items: completed,
        previousSnapshot,
        discovery: {
          anchor: { latitude: 35, longitude: -117 },
          requestItems: requestItems(completed),
          response: response(status, [
            store('new-store', ['item-batteries']),
          ]),
        },
      });

      expect(snapshot.generatedAt).toBe(LATER);
      expect(snapshot.discoveryAnchor).toEqual(ANCHOR);
      expect(snapshot.items.map((item) => item.id)).toEqual([
        'item-batteries',
      ]);
      expect(snapshot.stores).toEqual([
        expect.objectContaining({
          placeId: 'whole-foods',
          itemIds: ['item-batteries'],
        }),
      ]);
    },
  );

  it('returns an empty pool when partial discovery has no previous snapshot', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);

    const snapshot = buildCandidateSnapshotV1({
      generatedAt: GENERATED_AT,
      items: [milk],
      discovery: {
        anchor: ANCHOR,
        requestItems: requestItems([milk]),
        response: response('partial', [
          store('whole-foods', ['item-milk']),
        ]),
      },
    });

    expect(snapshot.items).toEqual([]);
    expect(snapshot.stores).toEqual([]);
  });

  it('treats no eligible active items as authoritative empty state', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const previousSnapshot = buildComplete([milk], [
      store('whole-foods', ['item-milk']),
    ]);
    const completed = completeItem([milk], 'item-milk', LATER);
    const currentAnchor = { latitude: 35, longitude: -117 };

    const snapshot = buildCandidateSnapshotV1({
      generatedAt: LATER,
      items: completed,
      previousSnapshot,
      discovery: {
        anchor: currentAnchor,
        requestItems: [],
        response: response('failed', []),
      },
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      generatedAt: LATER,
      discoveryAnchor: currentAnchor,
      items: [],
      stores: [],
    });
  });

  it('accepts a complete empty store result as a replacement snapshot', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const previousSnapshot = buildComplete([milk], [
      store('whole-foods', ['item-milk']),
    ]);

    const snapshot = buildCandidateSnapshotV1({
      generatedAt: LATER,
      items: [milk],
      previousSnapshot,
      discovery: {
        anchor: ANCHOR,
        requestItems: requestItems([milk]),
        response: response('complete', []),
      },
    });

    expect(snapshot.items.map((item) => item.id)).toEqual(['item-milk']);
    expect(snapshot.stores).toEqual([]);
  });

  it('preserves the full valid candidate pool without applying the 15-store cap', () => {
    const milk = classifiedItem('item-milk', 'Milk', ['grocery-store']);
    const stores = Array.from({ length: 16 }, (_, index) =>
      store(`store-${index.toString().padStart(2, '0')}`, ['item-milk']),
    );

    const snapshot = buildComplete([milk], stores);

    expect(snapshot.stores).toHaveLength(16);
  });
});
