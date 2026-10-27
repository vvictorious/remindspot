import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { Item } from '../models/Item';
import { useBackgroundDiscoveryInput } from './useBackgroundDiscoveryInput';

const mocks = vi.hoisted(() => ({
  setBackgroundDiscoveryInputAsync: vi.fn(async () => undefined),
}));

vi.mock(
  '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule',
  () => ({
    default: {
      setBackgroundDiscoveryInputAsync: mocks.setBackgroundDiscoveryInputAsync,
    },
  }),
);

const milk: Item = {
  id: 'milk',
  text: 'Milk',
  createdAt: '2026-10-23T17:00:00.000Z',
  updatedAt: '2026-10-23T17:00:00.000Z',
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

function Harness({
  isHydrated,
  items,
}: {
  isHydrated: boolean;
  items: readonly Item[];
}) {
  useBackgroundDiscoveryInput({ isHydrated, items });
  return null;
}

describe('useBackgroundDiscoveryInput', () => {
  beforeEach(() => {
    mocks.setBackgroundDiscoveryInputAsync.mockClear();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://192.168.1.20:3000/';
  });

  it('writes classified items and an empty list when nothing is classified', async () => {
    await act(async () => {
      TestRenderer.create(
        React.createElement(Harness, { isHydrated: false, items: [milk] }),
      );
    });
    expect(mocks.setBackgroundDiscoveryInputAsync).not.toHaveBeenCalled();

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(Harness, { isHydrated: true, items: [milk] }),
      );
    });
    expect(mocks.setBackgroundDiscoveryInputAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        apiBaseUrl: 'http://192.168.1.20:3000',
        items: [
          {
            id: 'milk',
            revision: 1,
            text: 'Milk',
            taxonomyVersion: 1,
            categories: ['grocery-store'],
          },
        ],
      }),
    );

    mocks.setBackgroundDiscoveryInputAsync.mockClear();
    await act(async () => {
      renderer.update(
        React.createElement(Harness, { isHydrated: true, items: [] }),
      );
    });
    expect(mocks.setBackgroundDiscoveryInputAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: 'http://192.168.1.20:3000',
        items: [],
      }),
    );
  });
});
