import {
  DESTINATION_CATEGORIES,
  DESTINATION_TAXONOMY_VERSION,
} from '../models/Classification';
import type { DestinationCategory } from '../models/Classification';

export type PlaceCandidatesRequest = {
  items: {
    id: string;
    revision: number;
    taxonomyVersion: typeof DESTINATION_TAXONOMY_VERSION;
    categories: [DestinationCategory, ...DestinationCategory[]];
  }[];
  location: {
    latitude: number;
    longitude: number;
  };
};

export type PlaceStore = {
  placeId: string;
  name: string;
  location: {
    latitude: number;
    longitude: number;
  };
  itemIds: string[];
};

export type PlaceCandidatesResponse = {
  status: 'complete' | 'partial' | 'failed';
  stores: PlaceStore[];
  categoryFailures: {
    category: DestinationCategory;
    code: 'provider-error';
  }[];
};

type RequestOptions = {
  signal?: AbortSignal;
};

function getServerBaseUrl() {
  const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

  if (!baseUrl) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL is not configured. Add it to the app .env.local file.',
    );
  }

  return baseUrl.replace(/\/+$/, '');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const destinationCategorySet = new Set<string>(DESTINATION_CATEGORIES);

function isDestinationCategory(
  value: unknown,
): value is DestinationCategory {
  return typeof value === 'string' && destinationCategorySet.has(value);
}

function parseStore(value: unknown): PlaceStore {
  if (!value || typeof value !== 'object') {
    throw new Error('The server returned an invalid place store.');
  }

  const store = value as Record<string, unknown>;
  const location = store.location;

  if (
    typeof store.placeId !== 'string' ||
    store.placeId.trim().length === 0 ||
    typeof store.name !== 'string' ||
    !location ||
    typeof location !== 'object' ||
    !Array.isArray(store.itemIds) ||
    !store.itemIds.every(
      (itemId) => typeof itemId === 'string' && itemId.trim().length > 0,
    )
  ) {
    throw new Error('The server returned an invalid place store.');
  }

  const coordinates = location as Record<string, unknown>;
  if (
    !isFiniteNumber(coordinates.latitude) ||
    !isFiniteNumber(coordinates.longitude)
  ) {
    throw new Error('The server returned invalid store coordinates.');
  }

  return {
    placeId: store.placeId,
    name: store.name,
    location: {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
    },
    itemIds: store.itemIds,
  };
}

export function parsePlaceCandidatesResponse(
  value: unknown,
): PlaceCandidatesResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('The server returned an invalid place candidates response.');
  }

  const response = value as Record<string, unknown>;
  if (
    !['complete', 'partial', 'failed'].includes(response.status as string) ||
    !Array.isArray(response.stores) ||
    !Array.isArray(response.categoryFailures)
  ) {
    throw new Error('The server returned an invalid place candidates response.');
  }

  const categoryFailures = response.categoryFailures.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('The server returned an invalid category failure.');
    }

    const failure = value as Record<string, unknown>;
    if (
      !isDestinationCategory(failure.category) ||
      failure.code !== 'provider-error'
    ) {
      throw new Error('The server returned an invalid category failure.');
    }

    return {
      category: failure.category,
      code: 'provider-error' as const,
    };
  });

  if (
    (response.status === 'complete' && categoryFailures.length > 0) ||
    (response.status !== 'complete' && categoryFailures.length === 0)
  ) {
    throw new Error('The server returned an inconsistent discovery status.');
  }

  return {
    status: response.status as PlaceCandidatesResponse['status'],
    stores: response.stores.map(parseStore),
    categoryFailures,
  };
}

export async function findPlaceCandidates(
  request: PlaceCandidatesRequest,
  options: RequestOptions = {},
): Promise<PlaceCandidatesResponse> {
  const response = await fetch(`${getServerBaseUrl()}/places/candidates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(
      `The places server request failed with status ${response.status}.`,
    );
  }

  const body: unknown = await response.json();
  return parsePlaceCandidatesResponse(body);
}
