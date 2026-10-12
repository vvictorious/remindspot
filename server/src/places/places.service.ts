import { Inject, Injectable } from '@nestjs/common';

import { DESTINATION_TAXONOMY_VERSION } from '../classification/classification-response';
import type { DestinationCategory } from './destination-category';
import { PLACES_PROVIDER } from './places-provider';
import type { PlacesProvider } from './places-provider';

export interface FindPlaceCandidatesRequest {
  items: readonly {
    id: string;
    revision: number;
    taxonomyVersion: typeof DESTINATION_TAXONOMY_VERSION;
    categories: readonly DestinationCategory[];
  }[];
  location: {
    latitude: number;
    longitude: number;
  };
}

export type PlaceDiscoveryStatus = 'complete' | 'partial' | 'failed';

export interface FindPlaceCandidatesResult {
  status: PlaceDiscoveryStatus;
  stores: readonly {
    placeId: string;
    name: string;
    location: {
      latitude: number;
      longitude: number;
    };
    itemIds: readonly string[];
  }[];
  categoryFailures: readonly {
    category: DestinationCategory;
    code: 'provider-error';
  }[];
}

@Injectable()
export class PlacesService {
  constructor(
    @Inject(PLACES_PROVIDER)
    private readonly provider: PlacesProvider,
  ) {}

  async findCandidates(
    request: FindPlaceCandidatesRequest,
  ): Promise<FindPlaceCandidatesResult> {
    const itemIdsByCategory = new Map<DestinationCategory, Set<string>>();
    for (const item of request.items) {
      for (const category of item.categories) {
        const itemIds = itemIdsByCategory.get(category) ?? new Set<string>();
        itemIds.add(item.id);
        itemIdsByCategory.set(category, itemIds);
      }
    }

    const categoryResults = await Promise.all(
      [...itemIdsByCategory].map(async ([category, itemIds]) => {
        try {
          const candidates = await this.provider.search({
            categories: [category],
            location: request.location,
          });

          return { category, itemIds, candidates, succeeded: true } as const;
        } catch {
          return { category, itemIds, succeeded: false } as const;
        }
      }),
    );

    const storesByPlaceId = new Map<
      string,
      {
        placeId: string;
        name: string;
        location: { latitude: number; longitude: number };
        itemIds: Set<string>;
      }
    >();
    const categoryFailures: {
      category: DestinationCategory;
      code: 'provider-error';
    }[] = [];

    for (const result of categoryResults) {
      if (!result.succeeded) {
        categoryFailures.push({
          category: result.category,
          code: 'provider-error',
        });
        continue;
      }

      for (const candidate of result.candidates) {
        const store = storesByPlaceId.get(candidate.id) ?? {
          placeId: candidate.id,
          name: candidate.name,
          location: candidate.location,
          itemIds: new Set<string>(),
        };
        for (const itemId of result.itemIds) {
          store.itemIds.add(itemId);
        }
        storesByPlaceId.set(candidate.id, store);
      }
    }

    const successfulCategoryCount =
      categoryResults.length - categoryFailures.length;

    return {
      status:
        categoryFailures.length === 0
          ? 'complete'
          : successfulCategoryCount === 0
            ? 'failed'
            : 'partial',
      stores: [...storesByPlaceId.values()].map((store) => ({
        ...store,
        itemIds: [...store.itemIds],
      })),
      categoryFailures,
    };
  }
}
