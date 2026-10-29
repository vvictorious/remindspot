import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backgroundDiscoveryPlaceItemsSignature,
} from '../native/background-discovery';
import type { PlaceCandidatesResponse } from '../api/places';
import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import {
  PLACE_DISCOVERY_DEBOUNCE_MS,
  PlaceDiscoveryCoordinator,
  type PlaceDiscoveryState,
} from './place-discovery-coordinator';
import type { PlaceRequestItem } from './place-item-projection';

const groceryItem: PlaceRequestItem = {
  id: 'item-1',
  revision: 1,
  taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
  categories: ['grocery-store'],
};

const completeResponse: PlaceCandidatesResponse = {
  status: 'complete',
  stores: [],
  categoryFailures: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function advance(delayMs = PLACE_DISCOVERY_DEBOUNCE_MS) {
  await vi.advanceTimersByTimeAsync(delayMs);
  await Promise.resolve();
}

describe('PlaceDiscoveryCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness(options?: {
    locations?: { latitude: number; longitude: number }[];
    discover?: (
      request: {
        items: PlaceRequestItem[];
        location: { latitude: number; longitude: number };
      },
      options?: { signal?: AbortSignal },
    ) => Promise<PlaceCandidatesResponse>;
    readPersistedDiscoveryAnchor?: () => Promise<{
      latitude: number;
      longitude: number;
      placeItemsSignature: string;
    } | null>;
  }) {
    const states: PlaceDiscoveryState[] = [];
    const locations = options?.locations ?? [
      { latitude: 34.027, longitude: -118.393 },
    ];
    let locationIndex = 0;
    const getLocation = vi.fn(async () => {
      const location =
        locations[Math.min(locationIndex, locations.length - 1)];
      locationIndex += 1;
      return location;
    });
    const discover = vi.fn(
      options?.discover ?? (async () => completeResponse),
    );
    const coordinator = new PlaceDiscoveryCoordinator({
      getLocation,
      discover,
      readPersistedDiscoveryAnchor: options?.readPersistedDiscoveryAnchor,
      onStateChange: (state) => states.push(state),
    });

    coordinator.start();

    return {
      coordinator,
      discover,
      getLocation,
      states,
      update(
        items: readonly PlaceRequestItem[],
        overrides: Partial<{
          isHydrated: boolean;
          isForeground: boolean;
          isDefinitelyOffline: boolean;
        }> = {},
      ) {
        coordinator.update({
          items,
          isHydrated: true,
          isForeground: true,
          isDefinitelyOffline: false,
          ...overrides,
        });
      },
    };
  }

  it('coalesces rapid eligible changes for 400 ms', async () => {
    const harness = createHarness();
    harness.update([groceryItem]);

    await advance(200);
    harness.update([
      { ...groceryItem, categories: ['convenience-store'] },
    ]);
    await advance(399);
    expect(harness.discover).not.toHaveBeenCalled();

    await advance(1);
    expect(harness.discover).toHaveBeenCalledOnce();
    expect(harness.discover.mock.calls[0][0].items[0].categories).toEqual([
      'convenience-store',
    ]);
  });

  it('deduplicates unchanged inputs and GPS drift below 200 meters', async () => {
    const harness = createHarness({
      locations: [
        { latitude: 34.027, longitude: -118.393 },
        { latitude: 34.028, longitude: -118.393 },
      ],
    });
    harness.update([groceryItem]);
    await advance();
    expect(harness.discover).toHaveBeenCalledOnce();

    harness.update([groceryItem], { isForeground: false });
    harness.update([groceryItem], { isForeground: true });
    await advance();

    expect(harness.getLocation).toHaveBeenCalledTimes(2);
    expect(harness.discover).toHaveBeenCalledOnce();
  });

  it('requests again after movement beyond 200 meters', async () => {
    const harness = createHarness({
      locations: [
        { latitude: 34.027, longitude: -118.393 },
        { latitude: 34.03, longitude: -118.393 },
      ],
    });
    harness.update([groceryItem]);
    await advance();

    harness.update([groceryItem], { isForeground: false });
    harness.update([groceryItem], { isForeground: true });
    await advance();

    expect(harness.discover).toHaveBeenCalledTimes(2);
  });

  it('searches again at the same coordinates after leaving the foreground mid-request', async () => {
    let resolveFirst: ((value: PlaceCandidatesResponse) => void) | undefined;
    const first = new Promise<PlaceCandidatesResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const second = deferred<PlaceCandidatesResponse>();
    const discover = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second.promise);
    const harness = createHarness({ discover });
    const location = { latitude: 34.027, longitude: -118.393 };

    harness.update([groceryItem]);
    await advance();
    expect(discover).toHaveBeenCalledOnce();
    expect(discover.mock.calls[0][0].location).toEqual(location);

    harness.update([groceryItem], { isForeground: false });
    expect(harness.states.at(-1)?.status).toBe('idle');
    harness.update([groceryItem], { isForeground: true });
    await advance();

    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1][0].location).toEqual(location);
    expect(harness.states.at(-1)?.status).toBe('loading');

    resolveFirst?.(completeResponse);
    await Promise.resolve();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(harness.states.at(-1)?.status).toBe('loading');
    expect(harness.states.at(-1)?.committedDiscovery).toBeNull();

    second.resolve(completeResponse);
    await Promise.resolve();
    expect(harness.states.at(-1)?.status).toBe('complete');
    expect(harness.states.at(-1)?.committedDiscovery?.anchor).toEqual(location);
  });

  it.each([
    ['an edit', [{ ...groceryItem, revision: 2 }]],
    ['a deletion', []],
  ])(
    'immediately invalidates associations and rejects a late response after %s',
    async (_name, nextItems) => {
      const pending = deferred<PlaceCandidatesResponse>();
      let signal: AbortSignal | undefined;
      const harness = createHarness({
        discover: async (_request, options) => {
          signal = options?.signal;
          return pending.promise;
        },
      });
      harness.update([groceryItem]);
      await advance();

      harness.update(nextItems as PlaceRequestItem[]);
      expect(signal?.aborted).toBe(true);
      expect(harness.states.at(-1)).toMatchObject({
        status: nextItems.length === 0 ? 'idle' : 'loading',
        stores: [],
        committedDiscovery: null,
      });

      pending.resolve({
        status: 'complete',
        stores: [
          {
            placeId: 'stale-place',
            name: 'Stale Store',
            location: { latitude: 34.027, longitude: -118.393 },
            itemIds: ['item-1'],
          },
        ],
        categoryFailures: [],
      });
      await Promise.resolve();

      expect(harness.states.at(-1)?.stores).toEqual([]);
      expect(harness.states.at(-1)?.committedDiscovery).toBeNull();
    },
  );

  it.each([
    ['background', { isForeground: false }],
    ['offline', { isDefinitelyOffline: true }],
  ])('aborts and rejects stale work when the app becomes %s', async (
    _name,
    gate,
  ) => {
    const pending = deferred<PlaceCandidatesResponse>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      discover: async (_request, options) => {
        signal = options?.signal;
        return pending.promise;
      },
    });
    harness.update([groceryItem]);
    await advance();

    harness.update([groceryItem], gate);
    expect(signal?.aborted).toBe(true);
    expect(harness.states.at(-1)?.status).toBe('idle');
    expect(harness.states.at(-1)?.committedDiscovery).toBeNull();

    pending.resolve(completeResponse);
    await Promise.resolve();
    expect(harness.states.at(-1)?.status).toBe('idle');
    expect(harness.states.at(-1)?.committedDiscovery).toBeNull();
  });

  it('clears candidates when the last eligible item leaves and discovers again when it returns', async () => {
    const stores = [
      {
        placeId: 'place-1',
        name: 'Market',
        location: { latitude: 34.027, longitude: -118.393 },
        itemIds: ['item-1'],
      },
    ];
    const harness = createHarness({
      discover: async () => ({
        status: 'complete',
        stores,
        categoryFailures: [],
      }),
    });
    harness.update([groceryItem]);
    await advance();
    expect(harness.states.at(-1)).toMatchObject({
      status: 'complete',
      stores,
    });

    harness.update([]);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'idle',
      stores: [],
    });
    expect(harness.discover).toHaveBeenCalledOnce();

    harness.update([groceryItem]);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'loading',
      stores: [],
    });
    await advance();
    expect(harness.discover).toHaveBeenCalledTimes(2);
    expect(harness.discover.mock.calls[1][0].items).toEqual([groceryItem]);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'complete',
      stores,
    });
  });

  it('keeps successful stores and all associations for partial results', async () => {
    const harness = createHarness({
      discover: async () => ({
        status: 'partial',
        stores: [
          {
            placeId: 'place-1',
            name: 'Market',
            location: { latitude: 34.027, longitude: -118.393 },
            itemIds: ['item-1', 'item-2'],
          },
        ],
        categoryFailures: [
          { category: 'pharmacy', code: 'provider-error' },
        ],
      }),
    });
    harness.update([
      groceryItem,
      { ...groceryItem, id: 'item-2', categories: ['pharmacy'] },
    ]);
    await advance();

    expect(harness.states.at(-1)).toMatchObject({
      status: 'partial',
      stores: [{ placeId: 'place-1', itemIds: ['item-1', 'item-2'] }],
      categoryFailures: [
        { category: 'pharmacy', code: 'provider-error' },
      ],
      canRetry: true,
    });
  });

  it('represents all-category failures separately from transport errors', async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed',
        stores: [],
        categoryFailures: [
          { category: 'grocery-store', code: 'provider-error' },
        ],
      })
      .mockRejectedValueOnce(new Error('network unavailable'));
    const harness = createHarness({ discover });
    harness.update([groceryItem]);
    await advance();
    const failedEnvelope = harness.states.at(-1)?.committedDiscovery;
    expect(harness.states.at(-1)).toMatchObject({
      status: 'failed',
      error: null,
      canRetry: true,
    });
    expect(failedEnvelope?.response.status).toBe('failed');

    harness.coordinator.retry();
    await advance(0);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'transport-error',
      error: expect.objectContaining({ message: 'network unavailable' }),
      canRetry: true,
    });
    expect(harness.states.at(-1)?.committedDiscovery).toBe(failedEnvelope);
  });

  it('preserves partial stores while an explicit retry is pending', async () => {
    const retryResponse = deferred<PlaceCandidatesResponse>();
    const discover = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'partial',
        stores: [
          {
            placeId: 'place-1',
            name: 'Market',
            location: { latitude: 34.027, longitude: -118.393 },
            itemIds: ['item-1'],
          },
        ],
        categoryFailures: [
          { category: 'pharmacy', code: 'provider-error' },
        ],
      })
      .mockReturnValueOnce(retryResponse.promise);
    const harness = createHarness({ discover });
    harness.update([
      { ...groceryItem, categories: ['grocery-store', 'pharmacy'] },
    ]);
    await advance();

    harness.coordinator.retry();
    await advance(0);
    expect(harness.discover).toHaveBeenCalledTimes(2);
    expect(harness.discover.mock.calls[1][0].items[0].categories).toEqual([
      'grocery-store',
      'pharmacy',
    ]);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'loading',
      stores: [{ placeId: 'place-1' }],
    });

    retryResponse.resolve(completeResponse);
    await Promise.resolve();
    expect(harness.states.at(-1)?.status).toBe('complete');
  });

  describe('committed discovery envelope', () => {
    const anchor = { latitude: 34.027, longitude: -118.393 };
    const market = {
      placeId: 'place-1',
      name: 'Market',
      location: { latitude: 34.028, longitude: -118.394 },
      itemIds: ['item-1'],
    };

    async function settle() {
      await vi.advanceTimersByTimeAsync(0);
    }

    it('commits an immutable envelope for one request and response', async () => {
      const response: PlaceCandidatesResponse = {
        status: 'complete',
        stores: [market],
        categoryFailures: [],
      };
      const requestItems: PlaceRequestItem[] = [
        {
          ...groceryItem,
          categories: ['convenience-store', 'grocery-store'],
        },
      ];
      const harness = createHarness({
        discover: async (request) => {
          expect(() => {
            request.items[0].categories.push('pharmacy');
          }).toThrow(TypeError);
          return response;
        },
      });

      harness.update(requestItems);
      await advance();

      const envelope = harness.states.at(-1)?.committedDiscovery;
      expect(envelope).toEqual({
        anchor,
        requestItems,
        response,
      });
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(Object.isFrozen(envelope?.anchor)).toBe(true);
      expect(Object.isFrozen(envelope?.requestItems)).toBe(true);
      expect(Object.isFrozen(envelope?.requestItems[0])).toBe(true);
      expect(Object.isFrozen(envelope?.requestItems[0].categories)).toBe(true);
      expect(Object.isFrozen(envelope?.response)).toBe(true);
      expect(Object.isFrozen(envelope?.response.stores[0])).toBe(true);
      expect(Object.isFrozen(envelope?.response.stores[0].location)).toBe(true);
      expect(Object.isFrozen(envelope?.response.stores[0].itemIds)).toBe(true);
      expect(envelope?.anchor).toBe(harness.discover.mock.calls[0][0].location);

      response.stores[0] = {
        ...response.stores[0],
        name: 'Changed after commit',
      };
      expect(envelope?.response.stores[0].name).toBe('Market');
      expect(() => {
        envelope!.anchor.latitude = 0;
      }).toThrow(TypeError);
    });

    it('rejects a stale response instead of pairing it with newer items', async () => {
      const requests: ReturnType<
        typeof deferred<PlaceCandidatesResponse>
      >[] = [];
      const harness = createHarness({
        discover: async () => {
          const pending = deferred<PlaceCandidatesResponse>();
          requests.push(pending);
          return pending.promise;
        },
      });

      harness.update([groceryItem]);
      await advance();
      harness.update([{ ...groceryItem, revision: 2 }]);
      await advance();
      expect(harness.states.at(-1)).toMatchObject({
        status: 'loading',
        committedDiscovery: null,
      });

      requests[0].resolve({
        status: 'complete',
        stores: [{ ...market, placeId: 'stale-place', name: 'Stale Store' }],
        categoryFailures: [],
      });
      await settle();
      expect(harness.states.at(-1)?.committedDiscovery).toBeNull();

      requests[1].resolve({
        status: 'complete',
        stores: [{ ...market, placeId: 'fresh-place', name: 'Fresh Store' }],
        categoryFailures: [],
      });
      await settle();

      expect(harness.states.at(-1)?.committedDiscovery).toEqual({
        anchor,
        requestItems: [{ ...groceryItem, revision: 2 }],
        response: {
          status: 'complete',
          stores: [
            { ...market, placeId: 'fresh-place', name: 'Fresh Store' },
          ],
          categoryFailures: [],
        },
      });
    });

    it('clears a committed envelope immediately when items change', async () => {
      const replacement = deferred<PlaceCandidatesResponse>();
      const discover = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'complete',
          stores: [market],
          categoryFailures: [],
        })
        .mockReturnValueOnce(replacement.promise);
      const harness = createHarness({ discover });

      harness.update([groceryItem]);
      await advance();
      expect(harness.states.at(-1)?.committedDiscovery?.response.stores).toEqual([
        market,
      ]);

      harness.update([{ ...groceryItem, revision: 2 }]);
      expect(harness.states.at(-1)).toMatchObject({
        status: 'loading',
        stores: [],
        committedDiscovery: null,
      });

      await advance();
      replacement.resolve({
        status: 'complete',
        stores: [{ ...market, placeId: 'replacement', itemIds: ['item-1'] }],
        categoryFailures: [],
      });
      await settle();

      expect(harness.states.at(-1)?.committedDiscovery).toMatchObject({
        requestItems: [{ id: 'item-1', revision: 2 }],
        response: {
          stores: [{ placeId: 'replacement', itemIds: ['item-1'] }],
        },
      });
      expect(
        harness.states.at(-1)?.committedDiscovery?.response.stores,
      ).not.toEqual([market]);
    });

    it('does not commit an envelope when the app backgrounds during discovery', async () => {
      const pending = deferred<PlaceCandidatesResponse>();
      const resumed = deferred<PlaceCandidatesResponse>();
      const discover = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(resumed.promise);
      const harness = createHarness({ discover });

      harness.update([groceryItem]);
      await advance();
      harness.update([groceryItem], { isForeground: false });
      expect(harness.states.at(-1)).toMatchObject({
        status: 'idle',
        committedDiscovery: null,
      });

      pending.resolve({
        status: 'complete',
        stores: [{ ...market, placeId: 'background-stale' }],
        categoryFailures: [],
      });
      await settle();
      expect(harness.states.at(-1)?.committedDiscovery).toBeNull();

      harness.update([groceryItem], { isForeground: true });
      await advance();
      expect(discover).toHaveBeenCalledTimes(2);
      expect(harness.states.at(-1)?.committedDiscovery).toBeNull();

      resumed.resolve({
        status: 'complete',
        stores: [market],
        categoryFailures: [],
      });
      await settle();
      expect(harness.states.at(-1)?.committedDiscovery?.response.stores).toEqual(
        [market],
      );
    });

    it('commits partial discovery separately and replaces that envelope atomically', async () => {
      const partialResponse: PlaceCandidatesResponse = {
        status: 'partial',
        stores: [market],
        categoryFailures: [
          { category: 'pharmacy', code: 'provider-error' },
        ],
      };
      const completeReplacement: PlaceCandidatesResponse = {
        status: 'complete',
        stores: [
          {
            ...market,
            placeId: 'place-2',
            name: 'Pharmacy',
            itemIds: ['item-1', 'item-2'],
          },
        ],
        categoryFailures: [],
      };
      const retry = deferred<PlaceCandidatesResponse>();
      const requestItems: PlaceRequestItem[] = [
        groceryItem,
        { ...groceryItem, id: 'item-2', categories: ['pharmacy'] },
      ];
      const discover = vi
        .fn()
        .mockResolvedValueOnce(partialResponse)
        .mockReturnValueOnce(retry.promise);
      const harness = createHarness({ discover });

      harness.update(requestItems);
      await advance();
      const partialEnvelope = harness.states.at(-1)?.committedDiscovery;
      expect(partialEnvelope).toEqual({
        anchor,
        requestItems,
        response: partialResponse,
      });
      expect(Object.isFrozen(partialEnvelope?.response.categoryFailures)).toBe(
        true,
      );

      harness.coordinator.retry();
      await advance(0);
      expect(harness.states.at(-1)).toMatchObject({
        status: 'loading',
        stores: [market],
      });
      expect(harness.states.at(-1)?.committedDiscovery).toBe(partialEnvelope);

      retry.resolve(completeReplacement);
      await settle();
      expect(harness.states.at(-1)?.committedDiscovery).toEqual({
        anchor,
        requestItems,
        response: completeReplacement,
      });
      expect(harness.states.at(-1)?.committedDiscovery).not.toBe(
        partialEnvelope,
      );
    });
  });

  it('skips a foreground search when background discovery already has a nearby anchor', async () => {
    const placeItemsSignature =
      backgroundDiscoveryPlaceItemsSignature([groceryItem]);
    const nearby = createHarness({
      locations: [{ latitude: 34.0274, longitude: -118.393 }],
      readPersistedDiscoveryAnchor: async () => ({
        latitude: 34.027,
        longitude: -118.393,
        placeItemsSignature,
      }),
    });
    nearby.update([groceryItem]);
    await advance();
    expect(nearby.discover).not.toHaveBeenCalled();

    const distant = createHarness({
      locations: [{ latitude: 34.047, longitude: -118.393 }],
      readPersistedDiscoveryAnchor: async () => ({
        latitude: 34.027,
        longitude: -118.393,
        placeItemsSignature,
      }),
    });
    distant.update([groceryItem]);
    await advance();
    expect(distant.discover).toHaveBeenCalledOnce();

    const changedItems = createHarness({
      locations: [{ latitude: 34.0274, longitude: -118.393 }],
      readPersistedDiscoveryAnchor: async () => ({
        latitude: 34.027,
        longitude: -118.393,
        placeItemsSignature: 'different-items',
      }),
    });
    changedItems.update([groceryItem]);
    await advance();
    expect(changedItems.discover).toHaveBeenCalledOnce();
  });
});
