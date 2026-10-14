import type {
  PlaceCandidatesResponse,
  PlaceStore,
} from '../api/places';
import {
  DESTINATION_CATEGORIES,
  type DestinationCategory,
} from '../models/Classification';
import type { Item } from '../models/Item';
import {
  createPlaceRequestItemsSignature,
  parsePlaceRequestItemsSignature,
  type PlaceRequestItem,
} from './place-item-projection';

export const CANDIDATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const GEOFENCE_RADIUS_METERS = 150;

export type CandidateCoordinatesV1 = {
  latitude: number;
  longitude: number;
};

export type CandidateSnapshotItemV1 = {
  id: string;
  revision: number;
  text: string;
  categories: [DestinationCategory, ...DestinationCategory[]];
};

export type CandidateSnapshotStoreV1 = {
  placeId: string;
  name: string;
  location: CandidateCoordinatesV1;
  itemIds: string[];
};

export type CandidateSnapshotV1 = {
  schemaVersion: typeof CANDIDATE_SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  discoveryAnchor: CandidateCoordinatesV1;
  items: CandidateSnapshotItemV1[];
  stores: CandidateSnapshotStoreV1[];
};

export type CandidateSnapshotDiscovery = {
  anchor: CandidateCoordinatesV1;
  requestItems: readonly PlaceRequestItem[];
  response: PlaceCandidatesResponse;
};

export type BuildCandidateSnapshotV1Input = {
  generatedAt: string;
  items: readonly Item[];
  discovery: CandidateSnapshotDiscovery;
  previousSnapshot?: CandidateSnapshotV1 | null;
};

export type SanitizeCandidateSnapshotV1Input = {
  generatedAt: string;
  items: readonly Item[];
  snapshot: CandidateSnapshotV1;
};

const categoryOrder = new Map(
  DESTINATION_CATEGORIES.map((category, index) => [category, index]),
);

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function sortCategories(
  categories: readonly DestinationCategory[],
): [DestinationCategory, ...DestinationCategory[]] {
  const sorted = [...new Set(categories)].sort(
    (left, right) =>
      (categoryOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (categoryOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );

  if (sorted.length === 0) {
    throw new Error('A candidate snapshot item must have a category.');
  }

  return sorted as [DestinationCategory, ...DestinationCategory[]];
}

function categoriesSignature(
  categories: readonly DestinationCategory[],
): string {
  return JSON.stringify(sortCategories(categories));
}

function compareSnapshotItems(
  left: CandidateSnapshotItemV1,
  right: CandidateSnapshotItemV1,
): number {
  return (
    compareStrings(left.id, right.id) ||
    compareNumbers(right.revision, left.revision) ||
    compareStrings(left.text, right.text) ||
    compareStrings(
      categoriesSignature(left.categories),
      categoriesSignature(right.categories),
    )
  );
}

function eligibleSnapshotItems(
  items: readonly Item[],
): CandidateSnapshotItemV1[] {
  const candidates = items.flatMap((item) => {
    const [requestItem] = parsePlaceRequestItemsSignature(
      createPlaceRequestItemsSignature([item]),
    );
    if (requestItem === undefined) {
      return [];
    }

    return [
      {
        id: item.id,
        revision: item.revision,
        text: item.text,
        categories: sortCategories(requestItem.categories),
      },
    ];
  });

  candidates.sort(compareSnapshotItems);

  const itemsById = new Map<string, CandidateSnapshotItemV1>();
  for (const item of candidates) {
    if (!itemsById.has(item.id)) {
      itemsById.set(item.id, item);
    }
  }

  return [...itemsById.values()];
}

function canonicalRequestSignature(
  requestItems: readonly PlaceRequestItem[],
): string {
  return JSON.stringify(
    requestItems
      .map((item) => ({
        ...item,
        categories: sortCategories(item.categories),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

function isValidCoordinates(
  location: CandidateCoordinatesV1,
): boolean {
  return (
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function compareStores(left: PlaceStore, right: PlaceStore): number {
  return (
    compareStrings(left.placeId, right.placeId) ||
    compareStrings(left.name, right.name) ||
    compareNumbers(left.location.latitude, right.location.latitude) ||
    compareNumbers(left.location.longitude, right.location.longitude)
  );
}

function canonicalStores(
  stores: readonly PlaceStore[],
  validItemIds: ReadonlySet<string>,
): CandidateSnapshotStoreV1[] {
  const storesByPlaceId = new Map<string, CandidateSnapshotStoreV1>();

  for (const store of [...stores].sort(compareStores)) {
    if (
      store.placeId.trim().length === 0 ||
      store.name.trim().length === 0 ||
      !isValidCoordinates(store.location)
    ) {
      continue;
    }

    const itemIds = [
      ...new Set(store.itemIds.filter((itemId) => validItemIds.has(itemId))),
    ].sort(compareStrings);
    if (itemIds.length === 0) {
      continue;
    }

    const existing = storesByPlaceId.get(store.placeId);
    if (existing === undefined) {
      storesByPlaceId.set(store.placeId, {
        placeId: store.placeId,
        name: store.name,
        location: { ...store.location },
        itemIds,
      });
      continue;
    }

    existing.itemIds = [...new Set([...existing.itemIds, ...itemIds])].sort(
      compareStrings,
    );
  }

  return [...storesByPlaceId.values()];
}

function emptySnapshot(
  generatedAt: string,
  discoveryAnchor: CandidateCoordinatesV1,
): CandidateSnapshotV1 {
  return {
    schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    discoveryAnchor: { ...discoveryAnchor },
    items: [],
    stores: [],
  };
}

function retainPreviousSnapshot(
  input: BuildCandidateSnapshotV1Input,
): CandidateSnapshotV1 {
  if (input.previousSnapshot === undefined || input.previousSnapshot === null) {
    return emptySnapshot(input.generatedAt, input.discovery.anchor);
  }

  return sanitizeCandidateSnapshotV1({
    generatedAt: input.generatedAt,
    items: input.items,
    snapshot: input.previousSnapshot,
  });
}

export function sanitizeCandidateSnapshotV1({
  generatedAt,
  items,
  snapshot,
}: SanitizeCandidateSnapshotV1Input): CandidateSnapshotV1 {
  const currentItemsById = new Map(
    eligibleSnapshotItems(items).map((item) => [item.id, item]),
  );
  const retainedItemsById = new Map<string, CandidateSnapshotItemV1>();

  for (const snapshotItem of [...snapshot.items].sort(compareSnapshotItems)) {
    const currentItem = currentItemsById.get(snapshotItem.id);
    if (
      currentItem === undefined ||
      currentItem.revision !== snapshotItem.revision ||
      currentItem.text !== snapshotItem.text ||
      categoriesSignature(currentItem.categories) !==
        categoriesSignature(snapshotItem.categories)
    ) {
      continue;
    }

    retainedItemsById.set(currentItem.id, currentItem);
  }

  const retainedItems = [...retainedItemsById.values()].sort(
    compareSnapshotItems,
  );
  const retainedItemIds = new Set(retainedItems.map((item) => item.id));

  return {
    schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    discoveryAnchor: { ...snapshot.discoveryAnchor },
    items: retainedItems,
    stores: canonicalStores(snapshot.stores, retainedItemIds),
  };
}

export function buildCandidateSnapshotV1(
  input: BuildCandidateSnapshotV1Input,
): CandidateSnapshotV1 {
  const eligibleItems = eligibleSnapshotItems(input.items);

  if (eligibleItems.length === 0) {
    return emptySnapshot(input.generatedAt, input.discovery.anchor);
  }

  if (input.discovery.response.status !== 'complete') {
    return retainPreviousSnapshot(input);
  }

  const currentRequestSignature = createPlaceRequestItemsSignature(input.items);
  const responseRequestSignature = canonicalRequestSignature(
    input.discovery.requestItems,
  );
  if (currentRequestSignature !== responseRequestSignature) {
    return retainPreviousSnapshot(input);
  }

  const eligibleItemIds = new Set(eligibleItems.map((item) => item.id));

  return {
    schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    discoveryAnchor: { ...input.discovery.anchor },
    items: eligibleItems,
    stores: canonicalStores(
      input.discovery.response.stores,
      eligibleItemIds,
    ),
  };
}
