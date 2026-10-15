import {
  compareStrings,
  distanceInMeters,
  type MatchingCoordinates,
} from './distance';

/**
 * Portable copy of the Swift geofence constants and item-aware selection.
 * Production Swift and `selectNearestNativeStores` remain the runtime owners.
 */
export const MONITORED_STORE_LIMIT = 15;
export const DUPLICATE_STORE_DISTANCE_METERS = 30;
export const GEOFENCE_RADIUS_METERS = 100;

export type SelectableStore = {
  placeId: string;
  name: string;
  location: MatchingCoordinates;
  itemIds: readonly string[];
};

export type MonitoredStore = {
  placeId: string;
  name: string;
  location: MatchingCoordinates;
  distanceMeters: number;
  itemIds: string[];
};

export type CollapsedStoreRecord = {
  droppedPlaceId: string;
  representativePlaceId: string;
};

export function normalizedBusinessIdentity(name: string): string {
  const tokens =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('en-US')
      .replace(/['’]/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const lastToken = tokens.at(-1);
  if (lastToken === 'pharmacy' || lastToken === 'drugstore') {
    tokens.pop();
  }
  return tokens.join(' ');
}

function representativeStorePrecedes(
  left: SelectableStore,
  right: SelectableStore,
): number {
  const lengthDifference =
    Array.from(left.name.trim()).length - Array.from(right.name.trim()).length;
  return lengthDifference || compareStrings(left.placeId, right.placeId);
}

export function collapseDuplicateStores(stores: readonly SelectableStore[]): {
  stores: SelectableStore[];
  collapsed: CollapsedStoreRecord[];
} {
  const collapsedStores: SelectableStore[] = [];
  const collapsed: CollapsedStoreRecord[] = [];

  for (const store of [...stores].sort(representativeStorePrecedes)) {
    const identity = normalizedBusinessIdentity(store.name);
    const duplicateIndex =
      identity.length === 0
        ? -1
        : collapsedStores.findIndex(
            (candidate) =>
              normalizedBusinessIdentity(candidate.name) === identity &&
              distanceInMeters(candidate.location, store.location) <=
                DUPLICATE_STORE_DISTANCE_METERS,
          );

    if (duplicateIndex === -1) {
      collapsedStores.push({
        ...store,
        location: { ...store.location },
        itemIds: [...store.itemIds],
      });
      continue;
    }

    const representative = collapsedStores[duplicateIndex];
    collapsedStores[duplicateIndex] = {
      ...representative,
      itemIds: [...new Set([...representative.itemIds, ...store.itemIds])].sort(
        compareStrings,
      ),
    };
    collapsed.push({
      droppedPlaceId: store.placeId,
      representativePlaceId: representative.placeId,
    });
  }

  return { stores: collapsedStores, collapsed };
}

export function selectMonitoredStores(input: {
  anchor: MatchingCoordinates;
  stores: readonly SelectableStore[];
}): {
  monitored: MonitoredStore[];
  excluded: MonitoredStore[];
  collapsed: CollapsedStoreRecord[];
} {
  const { stores, collapsed } = collapseDuplicateStores(input.stores);
  const ranked = stores
    .map((store) => ({
      placeId: store.placeId,
      name: store.name,
      location: store.location,
      distanceMeters: distanceInMeters(input.anchor, store.location),
      itemIds: [...store.itemIds].sort(compareStrings),
    }))
    .sort(
      (left, right) =>
        left.distanceMeters - right.distanceMeters ||
        compareStrings(left.placeId, right.placeId),
    );
  const remaining = [...ranked];
  const selected: MonitoredStore[] = [];
  const uncoveredItemIds = new Set(ranked.flatMap((store) => store.itemIds));

  while (selected.length < MONITORED_STORE_LIMIT && uncoveredItemIds.size > 0) {
    let bestIndex = -1;
    let bestCoverage = 0;

    for (const [index, store] of remaining.entries()) {
      const coverage = store.itemIds.filter((itemId) =>
        uncoveredItemIds.has(itemId),
      ).length;
      if (coverage > bestCoverage) {
        bestIndex = index;
        bestCoverage = coverage;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const [store] = remaining.splice(bestIndex, 1);
    selected.push(store);
    for (const itemId of store.itemIds) {
      uncoveredItemIds.delete(itemId);
    }
  }

  selected.push(...remaining.slice(0, MONITORED_STORE_LIMIT - selected.length));
  const selectedPlaceIds = new Set(selected.map((store) => store.placeId));
  const monitored = selected.sort(
    (left, right) =>
      left.distanceMeters - right.distanceMeters ||
      compareStrings(left.placeId, right.placeId),
  );

  return {
    monitored,
    excluded: ranked.filter((store) => !selectedPlaceIds.has(store.placeId)),
    collapsed,
  };
}
