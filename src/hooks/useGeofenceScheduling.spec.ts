import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeCandidateSnapshot } from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';
import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { Item } from '../models/Item';
import type { CommittedPlaceDiscovery } from './place-discovery-coordinator';
import { useGeofenceScheduling } from './useGeofenceScheduling';

const mocks = vi.hoisted(() => ({
  appState: 'active',
  appStateListener: undefined as ((state: string) => void) | undefined,
  notificationHandler: undefined as
    | {
        handleNotification: () => Promise<Record<string, boolean>>;
      }
    | undefined,
  removeAppStateListener: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationHandler: vi.fn(
    (handler: {
      handleNotification: () => Promise<Record<string, boolean>>;
    }) => {
      mocks.notificationHandler = handler;
    },
  ),
  getStateAsync: vi.fn(),
  syncAsync: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  PermissionStatus: { GRANTED: 'granted' },
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  setNotificationHandler: mocks.setNotificationHandler,
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

vi.mock(
  '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule',
  () => ({
    default: {
      getStateAsync: mocks.getStateAsync,
      syncAsync: mocks.syncAsync,
    },
  }),
);

const item: Item = {
  id: 'milk',
  text: 'Milk',
  createdAt: '2026-10-14T17:00:00.000Z',
  updatedAt: '2026-10-14T17:00:00.000Z',
  revision: 1,
  classification: {
    status: 'current',
    sourceRevision: 1,
    sourceText: 'Milk',
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    result: {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
  },
};

const committedDiscovery: CommittedPlaceDiscovery = {
  anchor: { latitude: 34.027, longitude: -118.393 },
  requestItems: [
    {
      id: item.id,
      revision: item.revision,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      categories: ['grocery-store'],
    },
  ],
  response: {
    status: 'complete',
    stores: [
      {
        placeId: 'market',
        name: 'Market',
        location: { latitude: 34.03, longitude: -118.39 },
        itemIds: [item.id],
      },
    ],
    categoryFailures: [],
  },
};

type HarnessProps = {
  isLoadingItems: boolean;
  discovery: CommittedPlaceDiscovery | null;
};

function Harness(props: HarnessProps) {
  useGeofenceScheduling({
    items: [item],
    isLoadingItems: props.isLoadingItems,
    committedDiscovery: props.discovery,
  });
  return null;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }
  });
}

describe('useGeofenceScheduling', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let currentSnapshot: NativeCandidateSnapshot | null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appState = 'active';
    mocks.appStateListener = undefined;
    mocks.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mocks.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
    currentSnapshot = null;
    mocks.getStateAsync.mockImplementation(async () => ({
      schemaVersion: 1,
      snapshot: currentSnapshot,
      requests: [],
      selectedPlaceIds:
        currentSnapshot?.stores.map((store) => store.placeId) ?? [],
      pendingManagedRequestIds: [],
      isDegraded: false,
    }));
    mocks.syncAsync.mockImplementation(
      async (snapshot: NativeCandidateSnapshot) => {
        currentSnapshot = snapshot;
        return {
          scheduledPlaceIds: snapshot.stores.map((store) => store.placeId),
          unchangedPlaceIds: [],
          canceledPlaceIds: [],
          consumedPlaceIds: [],
          retainedFallbackPlaceIds: [],
          failures: [],
          state: {
            schemaVersion: 1,
            snapshot,
            requests: [],
            selectedPlaceIds: snapshot.stores.map((store) => store.placeId),
            pendingManagedRequestIds: [],
            isDegraded: false,
          },
        };
      },
    );
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = undefined;
    }
  });

  it('requests notification permission, syncs discovery, presents in foreground, and refreshes on resume', async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(Harness, {
          isLoadingItems: true,
          discovery: null,
        }),
      );
    });
    await settle();

    expect(mocks.requestPermissionsAsync).toHaveBeenCalledOnce();
    expect(mocks.getStateAsync).toHaveBeenCalledOnce();
    expect(mocks.syncAsync).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.update(
        React.createElement(Harness, {
          isLoadingItems: false,
          discovery: committedDiscovery,
        }),
      );
    });
    await settle();
    expect(mocks.syncAsync).toHaveBeenCalledOnce();

    await expect(
      mocks.notificationHandler?.handleNotification(),
    ).resolves.toEqual({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    });

    await act(async () => {
      mocks.appStateListener?.('background');
      mocks.appState = 'background';
      mocks.appStateListener?.('active');
      mocks.appState = 'active';
    });
    await settle();

    expect(mocks.getStateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.syncAsync).toHaveBeenCalledOnce();
  });
});
