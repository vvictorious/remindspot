import {
  BadGatewayException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DestinationCategory } from './destination-category';
import {
  GooglePlacesProvider,
  GOOGLE_NEARBY_SEARCH_URL,
  GOOGLE_PLACES_FIELD_MASK,
  NEARBY_CANDIDATE_LIMIT,
  NEARBY_SEARCH_RADIUS_METERS,
} from './google-places.provider';

describe('GooglePlacesProvider', () => {
  const log = vi.fn<(message: unknown) => void>();

  beforeEach(() => {
    log.mockClear();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(log);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'grocery-store',
      [
        'grocery_store',
        'supermarket',
        'asian_grocery_store',
        'discount_supermarket',
        'health_food_store',
      ],
    ],
    ['convenience-store', ['convenience_store']],
    ['pharmacy', ['pharmacy', 'drugstore']],
    ['pet-store', ['pet_store']],
    ['hardware-store', ['hardware_store', 'home_improvement_store']],
    ['electronics-store', ['electronics_store']],
    ['department-store', ['department_store']],
    [
      'clothing-store',
      ['clothing_store', 'womens_clothing_store', 'sportswear_store'],
    ],
    ['auto-parts-store', ['auto_parts_store']],
    ['home-goods-store', ['home_goods_store']],
  ] as const satisfies readonly [DestinationCategory, readonly string[]][])(
    'maps %s searches to its Google primary types',
    async (category, googleTypes) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'google-place-1',
                displayName: { text: 'Local Market', languageCode: 'en' },
                location: { latitude: 34.01, longitude: -118.41 },
                types: ['grocery_store', 'store'],
              },
            ],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const provider = new GooglePlacesProvider(
        new ConfigService({ GOOGLE_PLACES_API_KEY: 'test-key' }),
      );

      await expect(
        provider.search({
          categories: [category],
          location: { latitude: 34, longitude: -118.4 },
        }),
      ).resolves.toEqual([
        {
          id: 'google-place-1',
          name: 'Local Market',
          location: { latitude: 34.01, longitude: -118.41 },
        },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(GOOGLE_NEARBY_SEARCH_URL);
      expect(options?.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': 'test-key',
        'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
      });
      if (typeof options?.body !== 'string') {
        throw new Error('Expected a JSON request body');
      }
      expect(JSON.parse(options.body)).toEqual({
        includedPrimaryTypes: googleTypes,
        maxResultCount: NEARBY_CANDIDATE_LIMIT,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: 34, longitude: -118.4 },
            radius: NEARBY_SEARCH_RADIUS_METERS,
          },
        },
      });
    },
  );

  it('keeps operational places and places that omit admission fields', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            {
              id: 'operational-place',
              displayName: { text: 'Open Market' },
              location: { latitude: 34.01, longitude: -118.41 },
              businessStatus: 'OPERATIONAL',
              pureServiceAreaBusiness: false,
            },
            {
              id: 'unspecified-place',
              displayName: { text: 'Neighborhood Shop' },
              location: { latitude: 34.02, longitude: -118.42 },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GooglePlacesProvider(
      new ConfigService({ GOOGLE_PLACES_API_KEY: 'test-key' }),
    );

    await expect(
      provider.search({
        categories: ['grocery-store'],
        location: { latitude: 34, longitude: -118.4 },
      }),
    ).resolves.toEqual([
      {
        id: 'operational-place',
        name: 'Open Market',
        location: { latitude: 34.01, longitude: -118.41 },
      },
      {
        id: 'unspecified-place',
        name: 'Neighborhood Shop',
        location: { latitude: 34.02, longitude: -118.42 },
      },
    ]);
  });

  it('drops closed and service-area-only places', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            {
              id: 'temporarily-closed',
              displayName: { text: 'Closed for the Week' },
              location: { latitude: 34.01, longitude: -118.41 },
              businessStatus: 'CLOSED_TEMPORARILY',
            },
            {
              id: 'permanently-closed',
              displayName: { text: 'Former Market' },
              location: { latitude: 34.02, longitude: -118.42 },
              businessStatus: 'CLOSED_PERMANENTLY',
              pureServiceAreaBusiness: false,
            },
            {
              id: 'service-area-only',
              displayName: { text: 'Mobile Supplement Co' },
              location: { latitude: 34.03, longitude: -118.43 },
              businessStatus: 'OPERATIONAL',
              pureServiceAreaBusiness: true,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GooglePlacesProvider(
      new ConfigService({ GOOGLE_PLACES_API_KEY: 'test-key' }),
    );

    await expect(
      provider.search({
        categories: ['pharmacy'],
        location: { latitude: 34, longitude: -118.4 },
      }),
    ).resolves.toEqual([]);
  });

  it('fails clearly without a configured API key', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GooglePlacesProvider(new ConfigService());

    await expect(
      provider.search({
        categories: ['grocery-store'],
        location: { latitude: 34, longitude: -118.4 },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('does not expose Google error payloads', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('credential details', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GooglePlacesProvider(
      new ConfigService({ GOOGLE_PLACES_API_KEY: 'test-key' }),
    );

    await expect(
      provider.search({
        categories: ['grocery-store'],
        location: { latitude: 34, longitude: -118.4 },
      }),
    ).rejects.toEqual(
      new BadGatewayException('Google Places request failed with status 403'),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    const logEntry = log.mock.calls[0][0] as Record<string, unknown>;
    expect(logEntry).toMatchObject({
      event: 'google_places.provider_request',
      categories: ['grocery-store'],
      requestCount: 1,
      success: false,
    });
    expect(typeof logEntry.durationMs).toBe('number');
    expect(JSON.stringify(log.mock.calls)).not.toContain('credential details');
  });

  it('logs one safe observation per successful provider request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            {
              id: 'private-place-id',
              displayName: { text: 'Private Place Name' },
              location: { latitude: 11.111111, longitude: -22.222222 },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GooglePlacesProvider(
      new ConfigService({ GOOGLE_PLACES_API_KEY: 'test-key' }),
    );

    await provider.search({
      categories: ['pharmacy'],
      location: { latitude: 12.345678, longitude: -98.765432 },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    const logEntry = log.mock.calls[0][0] as Record<string, unknown>;
    expect(logEntry).toMatchObject({
      event: 'google_places.provider_request',
      categories: ['pharmacy'],
      requestCount: 1,
      success: true,
    });
    expect(typeof logEntry.durationMs).toBe('number');
    expect(JSON.stringify(log.mock.calls)).not.toContain('12.345678');
    expect(JSON.stringify(log.mock.calls)).not.toContain('-98.765432');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-place-id');
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private Place Name');
    expect(JSON.stringify(log.mock.calls)).not.toContain('11.111111');
    expect(JSON.stringify(log.mock.calls)).not.toContain('-22.222222');
  });

  it('increments the request count without adding provider requests', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ places: [] }))),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GooglePlacesProvider(
      new ConfigService({ GOOGLE_PLACES_API_KEY: 'test-key' }),
    );

    await provider.search({
      categories: ['grocery-store'],
      location: { latitude: 34, longitude: -118.4 },
    });
    await provider.search({
      categories: ['pharmacy'],
      location: { latitude: 34, longitude: -118.4 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        categories: ['grocery-store'],
        requestCount: 1,
        success: true,
      }),
      expect.objectContaining({
        categories: ['pharmacy'],
        requestCount: 2,
        success: true,
      }),
    ]);
  });
});
