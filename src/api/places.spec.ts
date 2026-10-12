import { afterEach, describe, expect, it, vi } from 'vitest';

import { findPlaceCandidates, parsePlaceCandidatesResponse } from './places';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('parsePlaceCandidatesResponse', () => {
  it('parses the app-owned server response', () => {
    expect(
      parsePlaceCandidatesResponse({
        status: 'partial',
        stores: [
          {
            placeId: 'place-1',
            name: 'Sprouts Farmers Market',
            location: {
              latitude: 34.027,
              longitude: -118.393,
            },
            itemIds: ['item-1', 'item-2'],
          },
        ],
        categoryFailures: [
          { category: 'pharmacy', code: 'provider-error' },
        ],
      }),
    ).toEqual({
      status: 'partial',
      stores: [
        {
          placeId: 'place-1',
          name: 'Sprouts Farmers Market',
          location: {
            latitude: 34.027,
            longitude: -118.393,
          },
          itemIds: ['item-1', 'item-2'],
        },
      ],
      categoryFailures: [
        { category: 'pharmacy', code: 'provider-error' },
      ],
    });
  });

  it.each([
    null,
    {},
    { status: 'complete', stores: [], categoryFailures: [42] },
    {
      status: 'partial',
      stores: [],
      categoryFailures: [
        { category: 'unknown-store', code: 'provider-error' },
      ],
    },
    {
      status: 'complete',
      stores: [
        {
          placeId: 'place-1',
          name: 'Market',
          location: { latitude: '34', longitude: -118.393 },
          itemIds: ['item-1'],
        },
      ],
      categoryFailures: [],
    },
    { status: 'partial', stores: [], categoryFailures: [] },
  ])('rejects an invalid response: %j', (response) => {
    expect(() => parsePlaceCandidatesResponse(response)).toThrow();
  });
});

describe('findPlaceCandidates', () => {
  it('posts the app request to the configured server', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://192.168.1.23:3000/');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'complete',
          stores: [],
          categoryFailures: [],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = {
      items: [
        {
          id: 'item-1',
          revision: 2,
          taxonomyVersion: 1 as const,
          categories: ['grocery-store'] as ['grocery-store'],
        },
      ],
      location: { latitude: 34.027, longitude: -118.393 },
    };

    await expect(findPlaceCandidates(request)).resolves.toEqual({
      status: 'complete',
      stores: [],
      categoryFailures: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.23:3000/places/candidates',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
      }),
    );
  });

  it('returns category-level failures from an HTTP 200 response', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://192.168.1.23:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'failed',
            stores: [],
            categoryFailures: [
              { category: 'pharmacy', code: 'provider-error' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      findPlaceCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: 1,
            categories: ['pharmacy'],
          },
        ],
        location: { latitude: 34.027, longitude: -118.393 },
      }),
    ).resolves.toEqual({
      status: 'failed',
      stores: [],
      categoryFailures: [
        { category: 'pharmacy', code: 'provider-error' },
      ],
    });
  });

  it('rejects non-200 transport failures', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://192.168.1.23:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(
      findPlaceCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: 1,
            categories: ['pharmacy'],
          },
        ],
        location: { latitude: 34.027, longitude: -118.393 },
      }),
    ).rejects.toThrow('places server request failed with status 503');
  });
});
