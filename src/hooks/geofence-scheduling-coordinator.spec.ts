import { describe, expect, it, vi } from 'vitest';

import type {
  NativeCandidateSnapshot,
  NativeGeofenceState,
  NativeSyncResult,
} from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';
import type { PlaceCandidatesResponse } from '../api/places';
import {
  DESTINATION_TAXONOMY_VERSION,
  type DestinationCategory,
} from '../models/Classification';
import { completeItem, undoItemCompletion } from '../models/item-transitions';
import type { Item } from '../models/Item';
import { buildCandidateSnapshotV1 } from './geofence-candidate-snapshot';
import {
  GeofenceSchedulingCoordinator,
  type GeofenceSchedulingCoordinatorDependencies,
} from './geofence-scheduling-coordinator';
import type { CommittedPlaceDiscovery } from './place-discovery-coordinator';
import {
  createPlaceRequestItemsSignature,
  parsePlaceRequestItemsSignature,
} from './place-item-projection';

const ANCHOR = { latitude: 34.027, longitude: -118.393 };
const NOW = new Date('2026-10-14T18:00:00.000Z');

function classifiedItem(
  id: string,
  text: string,
  categories: [DestinationCategory, ...DestinationCategory[]] = [
    'grocery-store',
  ],
): Item {
  return {
    id,
    text,
    createdAt: '2026-10-14T17:00:00.000Z',
    updatedAt: '2026-10-14T17:00:00.000Z',
    revision: 1,
    classification: {
      status: 'current',
      sourceRevision: 1,
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

function discovery(
  items: readonly Item[],
  responseStatus: PlaceCandidatesResponse['status'] = 'complete',
): CommittedPlaceDiscovery {
  const response: PlaceCandidatesResponse = {
    status: responseStatus,
    stores: [
      {
        placeId: 'market',
        name: 'Market',
        location: { latitude: 34.03, longitude: -118.39 },
        itemIds: items.map((item) => item.id),
      },
    ],
    categoryFailures:
      responseStatus === 'complete'
        ? []
        : [{ category: 'grocery-store', code: 'provider-error' }],
  };

  return {
    anchor: ANCHOR,
    requestItems: parsePlaceRequestItemsSignature(
      createPlaceRequestItemsSignature(items),
    ),
    response,
  };
}

function nativeState(
  snapshot: NativeCandidateSnapshot | null,
): NativeGeofenceState {
  return {
    schemaVersion: 1,
    snapshot,
    requests: [],
    selectedPlaceIds: snapshot?.stores.map((store) => store.placeId) ?? [],
    pendingManagedRequestIds: [],
    isDegraded: false,
  };
}

function syncResult(snapshot: NativeCandidateSnapshot): NativeSyncResult {
  return {
    scheduledPlaceIds: snapshot.stores.map((store) => store.placeId),
    unchangedPlaceIds: [],
    canceledPlaceIds: [],
    consumedPlaceIds: [],
    retainedFallbackPlaceIds: [],
    failures: [],
    state: nativeState(snapshot),
  };
}

function storedSnapshot(items: readonly Item[]): NativeCandidateSnapshot {
  return buildCandidateSnapshotV1({
    generatedAt: '2026-10-14T17:30:00.000Z',
    items,
    discovery: discovery(items),
  });
}

async function settle() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(
  initialState: NativeGeofenceState = nativeState(null),
  syncImplementation?: (
    snapshot: NativeCandidateSnapshot,
  ) => Promise<NativeSyncResult>,
) {
  let currentState = initialState;
  const getStateAsync = vi.fn(async () => currentState);
  const getScheduledAsync = vi.fn<(identifier: string) => Promise<{ radius: number } | null>>(
    async () => null,
  );
  const syncAsync = vi.fn(
    syncImplementation ??
      (async (snapshot: NativeCandidateSnapshot) => {
        const result = syncResult(snapshot);
        currentState = result.state;
        return result;
      }),
  );
  const log = vi.fn();
  const dependencies: GeofenceSchedulingCoordinatorDependencies = {
    nativeClient: { getStateAsync, getScheduledAsync, syncAsync },
    now: () => NOW,
    log,
  };
  const coordinator = new GeofenceSchedulingCoordinator(dependencies);

  return { coordinator, getStateAsync, getScheduledAsync, syncAsync, log };
}

describe('GeofenceSchedulingCoordinator', () => {
  it('hydrates from native state and waits for item hydration before removing obsolete associations', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const batteries = classifiedItem('batteries', 'Batteries', [
      'hardware-store',
    ]);
    const harness = createHarness(
      nativeState(storedSnapshot([milk, batteries])),
    );

    harness.coordinator.update({
      items: [batteries],
      isHydrated: false,
      committedDiscovery: null,
    });
    harness.coordinator.start();
    await settle();
    expect(harness.getStateAsync).toHaveBeenCalledOnce();
    expect(harness.syncAsync).not.toHaveBeenCalled();

    harness.coordinator.update({
      items: [batteries],
      isHydrated: true,
      committedDiscovery: null,
    });
    await settle();

    expect(harness.syncAsync).toHaveBeenCalledOnce();
    expect(harness.syncAsync.mock.calls[0][0].items).toEqual([
      expect.objectContaining({ id: 'batteries' }),
    ]);
    expect(harness.syncAsync.mock.calls[0][0].stores[0].itemIds).toEqual([
      'batteries',
    ]);
  });

  it('installs complete committed discovery and ignores partial replacement data', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const harness = createHarness();
    harness.coordinator.start();
    harness.coordinator.update({
      items: [milk],
      isHydrated: true,
      committedDiscovery: discovery([milk], 'partial'),
    });
    await settle();
    expect(harness.syncAsync).not.toHaveBeenCalled();

    harness.coordinator.update({
      items: [milk],
      isHydrated: true,
      committedDiscovery: discovery([milk]),
    });
    await settle();

    expect(harness.syncAsync).toHaveBeenCalledOnce();
    expect(harness.syncAsync.mock.calls[0][0]).toMatchObject({
      discoveryAnchor: ANCHOR,
      items: [{ id: 'milk', text: 'Milk' }],
      stores: [{ placeId: 'market', itemIds: ['milk'] }],
    });
  });

  it('removes completed items immediately and does not restore them on undo until fresh discovery', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const committed = discovery([milk]);
    const harness = createHarness();
    harness.coordinator.start();
    harness.coordinator.update({
      items: [milk],
      isHydrated: true,
      committedDiscovery: committed,
    });
    await settle();

    const completed = completeItem(
      [milk],
      milk.id,
      '2026-10-14T18:01:00.000Z',
    );
    harness.coordinator.update({
      items: completed,
      isHydrated: true,
      committedDiscovery: committed,
    });
    await settle();
    expect(harness.syncAsync.mock.calls[1][0]).toMatchObject({
      items: [],
      stores: [],
    });

    const restored = undoItemCompletion(completed, milk.id);
    harness.coordinator.update({
      items: restored,
      isHydrated: true,
      committedDiscovery: committed,
    });
    await settle();
    expect(harness.syncAsync).toHaveBeenCalledTimes(2);

    harness.coordinator.update({
      items: restored,
      isHydrated: true,
      committedDiscovery: discovery(restored),
    });
    await settle();
    expect(harness.syncAsync).toHaveBeenCalledTimes(3);
    expect(harness.syncAsync.mock.calls[2][0].items[0].id).toBe('milk');
  });

  it('serializes native syncs and applies lifecycle changes after older work', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const firstSync = deferred<NativeSyncResult>();
    let callCount = 0;
    const harness = createHarness(nativeState(null), async (snapshot) => {
      callCount += 1;
      if (callCount === 1) {
        return firstSync.promise;
      }
      return syncResult(snapshot);
    });
    harness.coordinator.start();
    harness.coordinator.update({
      items: [milk],
      isHydrated: true,
      committedDiscovery: discovery([milk]),
    });
    await settle();
    expect(harness.syncAsync).toHaveBeenCalledOnce();

    const completed = completeItem(
      [milk],
      milk.id,
      '2026-10-14T18:01:00.000Z',
    );
    harness.coordinator.update({
      items: completed,
      isHydrated: true,
      committedDiscovery: null,
    });
    await settle();
    expect(harness.syncAsync).toHaveBeenCalledOnce();

    firstSync.resolve(syncResult(harness.syncAsync.mock.calls[0][0]));
    await settle();

    expect(harness.syncAsync).toHaveBeenCalledTimes(2);
    expect(harness.syncAsync.mock.calls[1][0]).toMatchObject({
      items: [],
      stores: [],
    });
  });

  it('refreshes native state on foreground resume without clearing a valid schedule', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const snapshot = storedSnapshot([milk]);
    const harness = createHarness(nativeState(snapshot));
    harness.coordinator.start();
    harness.coordinator.update({
      items: [milk],
      isHydrated: true,
      committedDiscovery: null,
    });
    await settle();
    expect(harness.syncAsync).not.toHaveBeenCalled();

    harness.coordinator.resume();
    await settle();

    expect(harness.getStateAsync).toHaveBeenCalledTimes(2);
    expect(harness.syncAsync).not.toHaveBeenCalled();
  });

  it('retries an unchanged degraded snapshot on foreground resume', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const snapshot = storedSnapshot([milk]);
    const healthy = nativeState(snapshot);
    const degraded = { ...healthy, isDegraded: true };
    const harness = createHarness(healthy);
    harness.getStateAsync
      .mockResolvedValueOnce(healthy)
      .mockResolvedValue(degraded);
    harness.coordinator.start();
    harness.coordinator.update({
      items: [milk],
      isHydrated: true,
      committedDiscovery: null,
    });
    await settle();
    expect(harness.syncAsync).not.toHaveBeenCalled();

    harness.coordinator.resume();
    await settle();

    expect(harness.syncAsync).toHaveBeenCalledOnce();
    expect(harness.syncAsync.mock.calls[0][0]).toMatchObject({
      discoveryAnchor: snapshot.discoveryAnchor,
      items: snapshot.items,
      stores: snapshot.stores,
    });
  });

  it('logs only genuinely pending stores with names, coordinates, and item text', async () => {
    const milk = classifiedItem('milk', 'Milk');
    const bread = classifiedItem('bread', 'Bread');
    const snapshot = storedSnapshot([milk, bread]);
    snapshot.stores.push({
      placeId: 'ralphs',
      name: 'Ralphs',
      location: { latitude: 34.0257, longitude: -118.433 },
      itemIds: ['milk', 'bread'],
    });
    const harness = createHarness({
      schemaVersion: 1,
      snapshot,
      selectedPlaceIds: ['ralphs'],
      pendingManagedRequestIds: ['tyg.arrival.v1.ralphs'],
      isDegraded: false,
      requests: [
        {
          placeId: 'ralphs',
          installationId: 'tyg.arrival.v1.ralphs',
          fingerprint: 'ralphs-fingerprint',
          status: 'pending',
          isPending: true,
          items: [
            { id: 'milk', revision: 1 },
            { id: 'bread', revision: 1 },
          ],
        },
        {
          placeId: 'market',
          installationId: 'tyg.arrival.v1.market',
          fingerprint: 'market-fingerprint',
          status: 'pending',
          isPending: false,
          items: [{ id: 'milk', revision: 1 }],
        },
        {
          placeId: 'market',
          installationId: 'tyg.arrival.v1.consumed',
          fingerprint: 'consumed-fingerprint',
          status: 'consumed',
          isPending: true,
          items: [{ id: 'milk', revision: 1 }],
        },
      ],
    });

    harness.coordinator.start();
    await settle();

    expect(harness.getScheduledAsync).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith('info', 'pending stores', {
      isDegraded: false,
      stores: [
        {
          name: 'Ralphs',
          latitude: 34.0257,
          longitude: -118.433,
          selected: true,
          items: 'Milk, Bread',
        },
      ],
    });
  });

  it('logs each pending store name and installed radius once after initialization', async () => {
    vi.stubGlobal('__DEV__', true);
    try {
      const milk = classifiedItem('milk', 'Milk');
      const snapshot = storedSnapshot([milk]);
      snapshot.stores.push({
        placeId: 'cvs',
        name: 'CVS',
        location: { latitude: 34.02, longitude: -118.43 },
        itemIds: ['milk'],
      });
      const harness = createHarness({
        schemaVersion: 1,
        snapshot,
        selectedPlaceIds: ['market', 'cvs'],
        pendingManagedRequestIds: [
          'tyg.arrival.v1.market',
          'tyg.arrival.v1.cvs',
        ],
        isDegraded: false,
        requests: [
          {
            placeId: 'market',
            installationId: 'tyg.arrival.v1.market',
            fingerprint: 'market-fingerprint',
            status: 'pending',
            isPending: true,
            items: [{ id: 'milk', revision: 1 }],
          },
          {
            placeId: 'cvs',
            installationId: 'tyg.arrival.v1.cvs',
            fingerprint: 'cvs-fingerprint',
            status: 'pending',
            isPending: true,
            items: [{ id: 'milk', revision: 1 }],
          },
          {
            placeId: 'fired',
            installationId: 'tyg.arrival.v1.fired',
            fingerprint: 'fired-fingerprint',
            status: 'consumed',
            isPending: false,
            items: [{ id: 'milk', revision: 1 }],
          },
        ],
      });
      harness.getScheduledAsync.mockImplementation(async (identifier: string) =>
        identifier.endsWith('.cvs') ? { radius: 100 } : { radius: 150 },
      );

      harness.coordinator.start();
      await settle();

      expect(harness.getScheduledAsync.mock.calls.map(([id]) => id)).toEqual([
        'tyg.arrival.v1.market',
        'tyg.arrival.v1.cvs',
      ]);
      expect(harness.log).toHaveBeenCalledWith('info', 'installed radii', {
        stores: [
          { name: 'Market', radiusMeters: 150 },
          { name: 'CVS', radiusMeters: 100 },
        ],
      });

      harness.coordinator.resume();
      harness.coordinator.update({
        items: [milk],
        isHydrated: true,
        committedDiscovery: discovery([milk]),
      });
      await settle();

      expect(harness.getScheduledAsync).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
