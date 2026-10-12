import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    pending.resolve(completeResponse);
    await Promise.resolve();
    expect(harness.states.at(-1)?.status).toBe('idle');
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
    expect(harness.states.at(-1)).toMatchObject({
      status: 'failed',
      error: null,
      canRetry: true,
    });

    harness.coordinator.retry();
    await advance(0);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'transport-error',
      error: expect.objectContaining({ message: 'network unavailable' }),
      canRetry: true,
    });
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
    harness.update([groceryItem]);
    await advance();

    harness.coordinator.retry();
    await advance(0);
    expect(harness.states.at(-1)).toMatchObject({
      status: 'loading',
      stores: [{ placeId: 'place-1' }],
    });

    retryResponse.resolve(completeResponse);
    await Promise.resolve();
    expect(harness.states.at(-1)?.status).toBe('complete');
  });
});
