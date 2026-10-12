import type { PlaceCandidatesRequest } from '../api/places';
import type { Item } from '../models/Item';

export type PlaceRequestItem = PlaceCandidatesRequest['items'][number];

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
  return JSON.stringify(
    items.flatMap((item) => {
      const requestItem = toPlaceRequestItem(item);
      return requestItem ? [requestItem] : [];
    }),
  );
}

export function parsePlaceRequestItemsSignature(
  signature: string,
): PlaceRequestItem[] {
  return JSON.parse(signature) as PlaceRequestItem[];
}
