import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { DESTINATION_TAXONOMY_VERSION } from '../classification/classification-response';
import { DESTINATION_CATEGORIES } from './destination-category';
import { PLACES_PROVIDER, PlacesProvider } from './places-provider';
import { PlacesService } from './places.service';

describe('PlacesService', () => {
  async function createService(search = vi.fn()) {
    const provider: PlacesProvider = { search };
    const module = await Test.createTestingModule({
      providers: [
        PlacesService,
        { provide: PLACES_PROVIDER, useValue: provider },
      ],
    }).compile();

    return { search, service: module.get(PlacesService) };
  }

  const location = { latitude: 34.05, longitude: -118.25 };

  it('queries every category on a multi-category item', async () => {
    const search = vi.fn<PlacesProvider['search']>().mockResolvedValue([]);
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 3,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'convenience-store'],
          },
        ],
        location,
      }),
    ).resolves.toEqual({
      status: 'complete',
      stores: [],
      categoryFailures: [],
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledWith({
      categories: ['grocery-store'],
      location,
    });
    expect(search).toHaveBeenCalledWith({
      categories: ['convenience-store'],
      location,
    });
  });

  it('shares one provider request across items with the same category', async () => {
    const search = vi.fn<PlacesProvider['search']>().mockResolvedValue([
      {
        id: 'google-place-1',
        name: 'Shared Market',
        location: { latitude: 34.051, longitude: -118.251 },
      },
    ]);
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
          {
            id: 'item-2',
            revision: 4,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
        ],
        location,
      }),
    ).resolves.toEqual({
      status: 'complete',
      stores: [
        {
          placeId: 'google-place-1',
          name: 'Shared Market',
          location: { latitude: 34.051, longitude: -118.251 },
          itemIds: ['item-1', 'item-2'],
        },
      ],
      categoryFailures: [],
    });
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith({
      categories: ['grocery-store'],
      location,
    });
  });

  it('queries every category in the validated taxonomy', async () => {
    const search = vi.fn<PlacesProvider['search']>().mockResolvedValue([]);
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: DESTINATION_CATEGORIES,
          },
        ],
        location,
      }),
    ).resolves.toMatchObject({ status: 'complete' });
    expect(search).toHaveBeenCalledTimes(DESTINATION_CATEGORIES.length);
  });

  it('normalizes duplicate provider results by Google Place ID', async () => {
    const search = vi.fn<PlacesProvider['search']>().mockResolvedValue([
      {
        id: 'google-place-1',
        name: 'Market',
        location: { latitude: 34.051, longitude: -118.251 },
      },
      {
        id: 'google-place-1',
        name: 'Market',
        location: { latitude: 34.051, longitude: -118.251 },
      },
    ]);
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
        ],
        location,
      }),
    ).resolves.toEqual({
      status: 'complete',
      stores: [
        {
          placeId: 'google-place-1',
          name: 'Market',
          location: { latitude: 34.051, longitude: -118.251 },
          itemIds: ['item-1'],
        },
      ],
      categoryFailures: [],
    });
  });

  it('merges shared Google places and associates all applicable item IDs', async () => {
    const search = vi.fn<PlacesProvider['search']>().mockResolvedValue([
      {
        id: 'google-place-1',
        name: 'Shared Store',
        location: { latitude: 34.051, longitude: -118.251 },
      },
    ]);
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'pharmacy'],
          },
          {
            id: 'item-2',
            revision: 2,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
        ],
        location,
      }),
    ).resolves.toEqual({
      status: 'complete',
      stores: [
        {
          placeId: 'google-place-1',
          name: 'Shared Store',
          location: { latitude: 34.051, longitude: -118.251 },
          itemIds: ['item-1', 'item-2'],
        },
      ],
      categoryFailures: [],
    });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps successful stores when another category fails', async () => {
    const search = vi
      .fn<PlacesProvider['search']>()
      .mockImplementation(({ categories }) =>
        categories[0] === 'pharmacy'
          ? Promise.reject(new Error('upstream failed'))
          : Promise.resolve([
              {
                id: 'google-place-1',
                name: 'Market',
                location: { latitude: 34.051, longitude: -118.251 },
              },
            ]),
      );
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
          {
            id: 'item-2',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['pharmacy'],
          },
        ],
        location,
      }),
    ).resolves.toEqual({
      status: 'partial',
      stores: [
        {
          placeId: 'google-place-1',
          name: 'Market',
          location: { latitude: 34.051, longitude: -118.251 },
          itemIds: ['item-1'],
        },
      ],
      categoryFailures: [{ category: 'pharmacy', code: 'provider-error' }],
    });
  });

  it('reports a failed result when every category fails', async () => {
    const search = vi
      .fn<PlacesProvider['search']>()
      .mockRejectedValue(new Error('upstream failed'));
    const { service } = await createService(search);

    await expect(
      service.findCandidates({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'pharmacy'],
          },
        ],
        location,
      }),
    ).resolves.toEqual({
      status: 'failed',
      stores: [],
      categoryFailures: [
        { category: 'grocery-store', code: 'provider-error' },
        { category: 'pharmacy', code: 'provider-error' },
      ],
    });
  });
});
