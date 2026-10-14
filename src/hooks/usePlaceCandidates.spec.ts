import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaceCandidatesResponse } from '../api/places';
import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { DestinationCategory } from '../models/Classification';
import type { Item } from '../models/Item';
import { PLACE_DISCOVERY_DEBOUNCE_MS } from './place-discovery-coordinator';
import {
  usePlaceCandidates,
  type UsePlaceCandidatesResult,
} from './usePlaceCandidates';

const mocks = vi.hoisted(() => ({
  appState: 'active',
  appStateListener: undefined as ((state: string) => void) | undefined,
  netInfoListener: undefined as
    | ((state: {
        isConnected: boolean | null;
        isInternetReachable: boolean | null;
      }) => void)
    | undefined,
  removeAppStateListener: vi.fn(),
  unsubscribeNetInfo: vi.fn(),
  requestForegroundPermissionsAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
  findPlaceCandidates: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: vi.fn(
      (_event: string, listener: (state: string) => void) => {
        mocks.appStateListener = listener;
        return { remove: mocks.removeAppStateListener };
      },
    ),
  },
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: vi.fn(
      (
        listener: (state: {
          isConnected: boolean | null;
          isInternetReachable: boolean | null;
        }) => void,
      ) => {
        mocks.netInfoListener = listener;
        return mocks.unsubscribeNetInfo;
      },
    ),
  },
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  PermissionStatus: { GRANTED: 'granted' },
  requestForegroundPermissionsAsync:
    mocks.requestForegroundPermissionsAsync,
  getCurrentPositionAsync: mocks.getCurrentPositionAsync,
}));

vi.mock('../api/places', () => ({
  findPlaceCandidates: mocks.findPlaceCandidates,
}));

type HarnessProps = {
  isLoadingItems: boolean;
  items: readonly Item[];
  onResult?: (result: UsePlaceCandidatesResult) => void;
};

function Harness(props: HarnessProps) {
  const result = usePlaceCandidates(props);
  React.useEffect(() => {
    props.onResult?.(result);
  }, [props, result]);
  return null;
}

function classifiedItem(
  categories: [DestinationCategory, ...DestinationCategory[]] = [
    'grocery-store',
  ],
): Item {
  return {
    id: 'item-1',
    text: 'Milk',
    createdAt: '2026-10-09T12:00:00.000Z',
    updatedAt: '2026-10-09T12:00:00.000Z',
    revision: 1,
    classification: {
      status: 'current',
      sourceRevision: 1,
      sourceText: 'Milk',
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      result: {
        outcome: 'classified',
        categories,
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    },
  };
}

function pendingEdit(item: Item): Item {
  return pendingItem({
    ...item,
    text: 'Oat milk',
    revision: 2,
  });
}

function pendingItem(item: Item): Item {
  return {
    ...item,
    classification: {
      status: 'pending',
      sourceRevision: item.revision,
      sourceText: item.text,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      attemptCount: 0,
      nextAttemptAt: null,
    },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceDiscovery() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PLACE_DISCOVERY_DEBOUNCE_MS);
  });
  await flushEffects();
}

describe('usePlaceCandidates', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.appState = 'active';
    mocks.appStateListener = undefined;
    mocks.netInfoListener = undefined;
    mocks.requestForegroundPermissionsAsync.mockResolvedValue({
      status: 'granted',
    });
    mocks.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 34.027, longitude: -118.393 },
    });
    mocks.findPlaceCandidates.mockResolvedValue({
      status: 'complete',
      stores: [],
      categoryFailures: [],
    });
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = undefined;
    }
    vi.useRealTimers();
  });

  async function render(props: HarnessProps) {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Harness, props));
    });
    await flushEffects();
  }

  async function update(props: HarnessProps) {
    await act(async () => {
      renderer?.update(React.createElement(Harness, props));
    });
    await flushEffects();
  }

  it('starts discovery when a pending classification becomes current', async () => {
    const classified = classifiedItem([
      'grocery-store',
      'convenience-store',
    ]);
    await render({
      isLoadingItems: false,
      items: [pendingItem(classified)],
    });
    expect(mocks.findPlaceCandidates).not.toHaveBeenCalled();

    await update({ isLoadingItems: false, items: [classified] });
    await advanceDiscovery();

    expect(mocks.findPlaceCandidates).toHaveBeenCalledWith(
      {
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'convenience-store'],
          },
        ],
        location: { latitude: 34.027, longitude: -118.393 },
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('waits for hydration before discovering places', async () => {
    const item = classifiedItem();
    await render({ isLoadingItems: true, items: [item] });
    expect(mocks.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    await update({ isLoadingItems: false, items: [item] });
    await advanceDiscovery();
    expect(mocks.findPlaceCandidates).toHaveBeenCalledOnce();
  });

  it('exposes store-centric partial results and their item associations', async () => {
    let latestResult: UsePlaceCandidatesResult | undefined;
    mocks.findPlaceCandidates.mockResolvedValue({
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
    });

    await render({
      isLoadingItems: false,
      items: [classifiedItem(['grocery-store', 'pharmacy'])],
      onResult: (result) => {
        latestResult = result;
      },
    });
    await advanceDiscovery();

    expect(latestResult).toMatchObject({
      status: 'partial',
      stores: [{ placeId: 'place-1', itemIds: ['item-1', 'item-2'] }],
      categoryFailures: [
        { category: 'pharmacy', code: 'provider-error' },
      ],
      canRetry: true,
      retry: expect.any(Function),
      committedDiscovery: {
        anchor: { latitude: 34.027, longitude: -118.393 },
        requestItems: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'pharmacy'],
          },
        ],
        response: {
          status: 'partial',
          stores: [{ placeId: 'place-1', itemIds: ['item-1', 'item-2'] }],
          categoryFailures: [
            { category: 'pharmacy', code: 'provider-error' },
          ],
        },
      },
    });
  });

  it('waits until the app returns to the foreground', async () => {
    mocks.appState = 'background';
    const item = classifiedItem();
    await render({ isLoadingItems: false, items: [item] });
    expect(mocks.findPlaceCandidates).not.toHaveBeenCalled();

    await act(async () => mocks.appStateListener?.('active'));
    await flushEffects();
    await advanceDiscovery();
    expect(mocks.findPlaceCandidates).toHaveBeenCalledOnce();
  });

  it('does not discover while connectivity is definitely offline', async () => {
    await render({ isLoadingItems: false, items: [] });

    await act(async () =>
      mocks.netInfoListener?.({
        isConnected: false,
        isInternetReachable: false,
      }),
    );
    await update({
      isLoadingItems: false,
      items: [classifiedItem()],
    });
    expect(mocks.findPlaceCandidates).not.toHaveBeenCalled();

    await act(async () =>
      mocks.netInfoListener?.({
        isConnected: true,
        isInternetReachable: true,
      }),
    );
    await flushEffects();
    await advanceDiscovery();
    expect(mocks.findPlaceCandidates).toHaveBeenCalledOnce();
  });

  it.each([
    ['an edit', (item: Item) => [pendingEdit(item)]],
    ['a deletion', () => []],
  ])('aborts an in-flight request after %s', async (_name, obsoleteItems) => {
    let requestSignal: AbortSignal | undefined;
    mocks.findPlaceCandidates.mockImplementation(
      (_request: unknown, options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return new Promise(() => undefined);
      },
    );
    const item = classifiedItem();
    await render({ isLoadingItems: false, items: [item] });
    await advanceDiscovery();
    expect(requestSignal?.aborted).toBe(false);

    await update({
      isLoadingItems: false,
      items: obsoleteItems(item),
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts the obsolete request and starts another when categories change', async () => {
    const signals: AbortSignal[] = [];
    mocks.findPlaceCandidates.mockImplementation(
      (_request: unknown, options: { signal?: AbortSignal }) => {
        if (options.signal) {
          signals.push(options.signal);
        }
        return new Promise(() => undefined);
      },
    );
    await render({
      isLoadingItems: false,
      items: [classifiedItem(['grocery-store'])],
    });
    await advanceDiscovery();

    await update({
      isLoadingItems: false,
      items: [classifiedItem(['convenience-store'])],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    await advanceDiscovery();
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);
    expect(mocks.findPlaceCandidates.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ categories: ['convenience-store'] }),
        ],
      }),
    );
  });

  it('exposes the committed discovery envelope for a successful request', async () => {
    const response: PlaceCandidatesResponse = {
      status: 'complete',
      stores: [
        {
          placeId: 'place-1',
          name: 'Market',
          location: { latitude: 34.03, longitude: -118.39 },
          itemIds: ['item-1'],
        },
      ],
      categoryFailures: [],
    };
    mocks.findPlaceCandidates.mockResolvedValue(response);
    let latestResult: UsePlaceCandidatesResult | undefined;

    await render({
      isLoadingItems: false,
      items: [classifiedItem()],
      onResult: (result) => {
        latestResult = result;
      },
    });
    expect(latestResult?.committedDiscovery).toBeNull();

    await advanceDiscovery();

    expect(latestResult?.committedDiscovery).toEqual({
      anchor: { latitude: 34.027, longitude: -118.393 },
      requestItems: [
        {
          id: 'item-1',
          revision: 1,
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
          categories: ['grocery-store'],
        },
      ],
      response,
    });
    expect(Object.isFrozen(latestResult?.committedDiscovery)).toBe(true);
  });

  it('drops the envelope when an edit supersedes in-flight discovery', async () => {
    let resolveRequest: ((value: PlaceCandidatesResponse) => void) | undefined;
    mocks.findPlaceCandidates.mockImplementation(
      () =>
        new Promise<PlaceCandidatesResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const item = classifiedItem();
    let latestResult: UsePlaceCandidatesResult | undefined;
    await render({
      isLoadingItems: false,
      items: [item],
      onResult: (result) => {
        latestResult = result;
      },
    });
    await advanceDiscovery();

    await update({
      isLoadingItems: false,
      items: [pendingEdit(item)],
    });
    expect(latestResult?.committedDiscovery).toBeNull();

    await act(async () => {
      resolveRequest?.({
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
    });
    await flushEffects();

    expect(latestResult?.committedDiscovery).toBeNull();
    expect(latestResult?.stores).toEqual([]);
  });

  it('does not publish a stale envelope when discovery is backgrounded', async () => {
    let resolveRequest: ((value: PlaceCandidatesResponse) => void) | undefined;
    mocks.findPlaceCandidates.mockImplementation(
      () =>
        new Promise<PlaceCandidatesResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    let latestResult: UsePlaceCandidatesResult | undefined;
    await render({
      isLoadingItems: false,
      items: [classifiedItem()],
      onResult: (result) => {
        latestResult = result;
      },
    });
    await advanceDiscovery();

    await act(async () => mocks.appStateListener?.('background'));
    await flushEffects();
    expect(latestResult).toMatchObject({
      status: 'idle',
      committedDiscovery: null,
    });

    await act(async () => {
      resolveRequest?.({
        status: 'complete',
        stores: [
          {
            placeId: 'background-stale',
            name: 'Stale Store',
            location: { latitude: 34.027, longitude: -118.393 },
            itemIds: ['item-1'],
          },
        ],
        categoryFailures: [],
      });
    });
    await flushEffects();

    expect(latestResult?.committedDiscovery).toBeNull();
  });
});
