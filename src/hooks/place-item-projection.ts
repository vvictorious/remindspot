import type { PlaceCandidatesRequest } from '../api/places';
import { DESTINATION_CATEGORIES } from '../models/Classification';
import type { Item } from '../models/Item';

export type PlaceRequestItem = PlaceCandidatesRequest['items'][number];

const categoryOrder = new Map(
  DESTINATION_CATEGORIES.map((category, index) => [category, index]),
);

function toPlaceRequestItem(item: Item): PlaceRequestItem | null {
  const { classification } = item;
  if (
    classification.status !== 'current' ||
    classification.sourceRevision !== item.revision ||
    classification.result.outcome !== 'classified'
  ) {
    return null;
  }

  return {
    id: item.id,
    revision: item.revision,
    taxonomyVersion: classification.result.taxonomyVersion,
    categories: [...classification.result.categories],
  };
}

export function createPlaceRequestItemsSignature(
  items: readonly Item[],
): string {
  const requestItems = items
    .flatMap((item) => {
      const requestItem = toPlaceRequestItem(item);
      return requestItem ? [requestItem] : [];
    })
    .map((item) => ({
      ...item,
      categories: [...item.categories].sort(
        (left, right) =>
          (categoryOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (categoryOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
      ) as PlaceRequestItem['categories'],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return JSON.stringify(requestItems);
}

export function parsePlaceRequestItemsSignature(
  signature: string,
): PlaceRequestItem[] {
  return JSON.parse(signature) as PlaceRequestItem[];
}
