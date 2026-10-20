import {
  DESTINATION_CATEGORIES,
  type DestinationCategory,
} from '../models/Classification';
import type { CandidateSnapshotV1 } from '../hooks/geofence-candidate-snapshot';

export const NATIVE_CANDIDATE_SCHEMA_VERSION = 1;
export const NATIVE_GEOFENCE_RADIUS_METERS = 100;
export const NATIVE_DUPLICATE_STORE_DISTANCE_METERS = 30;
export const NATIVE_MAX_MONITORED_STORES = 15;
export const NATIVE_MAX_LOCATION_TRIGGERS = 20;
export const NATIVE_MANAGED_IDENTIFIER_PREFIX = 'tyg.arrival.v1.';
export const NATIVE_STATE_STORAGE_KEY =
  'there-you-go.location-notifications.state.v1';
export const NATIVE_MAX_ITEMS = 500;
export const NATIVE_MAX_STORES = 500;
export const NATIVE_MAX_IDENTIFIER_LENGTH = 512;
export const NATIVE_MAX_ITEM_TEXT_LENGTH = 500;
export const NATIVE_MAX_STORE_NAME_LENGTH = 256;
export const NATIVE_MAX_CATEGORIES_PER_ITEM = 10;
export const NATIVE_MAX_DISPLAYED_ITEM_LENGTH = 80;
export const NATIVE_MAX_NOTIFICATION_BODY_LENGTH = 180;
export const NATIVE_MAX_NAMED_ITEMS_IN_BODY = 3;

const knownCategories = new Set<string>(DESTINATION_CATEGORIES);
const categoryOrder = new Map(
  DESTINATION_CATEGORIES.map((category, index) => [category, index]),
);

export type NativeContractCoordinates = {
  latitude: number;
  longitude: number;
};

export type NativeContractItem = {
  id: string;
  revision: number;
  text: string;
  categories: string[];
};

export type NativeContractStore = {
  placeId: string;
  name: string;
  location: NativeContractCoordinates;
  itemIds: string[];
};

export type NativeContractSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  discoveryAnchor: NativeContractCoordinates;
  items: NativeContractItem[];
  stores: NativeContractStore[];
};

export type NativeItemReference = {
  id: string;
  revision: number;
};

export type DesiredNativeStore = {
  placeId: string;
  name: string;
  location: NativeContractCoordinates;
  distanceMeters: number;
  itemReferences: NativeItemReference[];
  itemIds: string[];
  title: string;
  body: string;
  fingerprintInput: {
    placeId: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    items: { id: string; revision: number; text: string }[];
  };
};

export type NativeRequestTransition =
  | 'unchanged'
  | 'lifecycle-invalid'
  | 'content-change'
  | 'consumed-same-fingerprint'
  | 'add';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isValidCoordinates(location: NativeContractCoordinates): boolean {
  return (
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function isIso8601Timestamp(value: string): boolean {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }

  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

function assertNonEmptyText(
  value: string,
  field: string,
  maximumLength: number,
): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${field} is too long.`);
  }
}

function distanceInMeters(
  left: NativeContractCoordinates,
  right: NativeContractCoordinates,
): number {
  const earthRadiusMeters = 6_371_000;
  const degreesToRadians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * degreesToRadians;
  const longitudeDelta = (right.longitude - left.longitude) * degreesToRadians;
  const leftLatitude = left.latitude * degreesToRadians;
  const rightLatitude = right.latitude * degreesToRadians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function normalizedBusinessIdentity(name: string): string {
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
  left: NativeContractStore,
  right: NativeContractStore,
): number {
  const lengthDifference =
    Array.from(left.name.trim()).length - Array.from(right.name.trim()).length;
  return lengthDifference || compareStrings(left.placeId, right.placeId);
}

function collapseDuplicateStores(
  stores: readonly NativeContractStore[],
): NativeContractStore[] {
  const collapsed: NativeContractStore[] = [];

  for (const store of [...stores].sort(representativeStorePrecedes)) {
    const identity = normalizedBusinessIdentity(store.name);
    const duplicateIndex =
      identity.length === 0
        ? -1
        : collapsed.findIndex(
            (candidate) =>
              normalizedBusinessIdentity(candidate.name) === identity &&
              distanceInMeters(candidate.location, store.location) <=
                NATIVE_DUPLICATE_STORE_DISTANCE_METERS,
          );

    if (duplicateIndex === -1) {
      collapsed.push(store);
      continue;
    }

    const representative = collapsed[duplicateIndex];
    collapsed[duplicateIndex] = {
      ...representative,
      itemIds: [...new Set([...representative.itemIds, ...store.itemIds])].sort(
        compareStrings,
      ),
    };
  }

  return collapsed;
}

function concise(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  return `${value.slice(0, maximumLength - 1)}…`;
}

function normalizedWhitespace(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ');
}

export function isManagedInstallationId(identifier: string): boolean {
  return identifier.startsWith(NATIVE_MANAGED_IDENTIFIER_PREFIX);
}

export function validateNativeCandidateSnapshot(
  snapshot: NativeContractSnapshot,
): NativeContractSnapshot {
  if (snapshot.schemaVersion !== NATIVE_CANDIDATE_SCHEMA_VERSION) {
    throw new Error('unsupported schemaVersion.');
  }
  if (!isIso8601Timestamp(snapshot.generatedAt)) {
    throw new Error('generatedAt must be an ISO-8601 timestamp.');
  }
  if (!isValidCoordinates(snapshot.discoveryAnchor)) {
    throw new Error('discoveryAnchor is invalid.');
  }
  if (snapshot.items.length > NATIVE_MAX_ITEMS) {
    throw new Error('too many items.');
  }
  if (snapshot.stores.length > NATIVE_MAX_STORES) {
    throw new Error('too many stores.');
  }

  const itemIds = new Set<string>();
  const items = [...snapshot.items]
    .map((item) => {
      assertNonEmptyText(item.id, 'item id', NATIVE_MAX_IDENTIFIER_LENGTH);
      if (itemIds.has(item.id)) {
        throw new Error('item ids must be unique.');
      }
      itemIds.add(item.id);
      if (!Number.isInteger(item.revision) || item.revision <= 0) {
        throw new Error('item revisions must be positive.');
      }
      assertNonEmptyText(
        item.text,
        'item text',
        NATIVE_MAX_ITEM_TEXT_LENGTH,
      );
      if (
        item.categories.length === 0 ||
        item.categories.length > NATIVE_MAX_CATEGORIES_PER_ITEM
      ) {
        throw new Error('items must have one or more categories.');
      }
      if (new Set(item.categories).size !== item.categories.length) {
        throw new Error('item categories must be unique.');
      }
      if (!item.categories.every((category) => knownCategories.has(category))) {
        throw new Error('an item contains an unknown category.');
      }

      return {
        ...item,
        categories: [...item.categories].sort(
          (left, right) =>
            (categoryOrder.get(left as DestinationCategory) ??
              Number.MAX_SAFE_INTEGER) -
            (categoryOrder.get(right as DestinationCategory) ??
              Number.MAX_SAFE_INTEGER),
        ),
      };
    })
    .sort((left, right) => compareStrings(left.id, right.id));

  const placeIds = new Set<string>();
  const stores = [...snapshot.stores]
    .map((store) => {
      assertNonEmptyText(store.placeId, 'placeId', NATIVE_MAX_IDENTIFIER_LENGTH);
      if (placeIds.has(store.placeId)) {
        throw new Error('placeIds must be unique.');
      }
      placeIds.add(store.placeId);
      assertNonEmptyText(
        store.name,
        'store name',
        NATIVE_MAX_STORE_NAME_LENGTH,
      );
      if (!isValidCoordinates(store.location)) {
        throw new Error('store location is invalid.');
      }
      if (store.itemIds.length === 0) {
        throw new Error('stores must reference at least one item.');
      }
      if (new Set(store.itemIds).size !== store.itemIds.length) {
        throw new Error('store itemIds must be unique.');
      }
      if (!store.itemIds.every((itemId) => itemIds.has(itemId))) {
        throw new Error('a store references an unknown item.');
      }

      return {
        ...store,
        location: { ...store.location },
        itemIds: [...store.itemIds].sort(compareStrings),
      };
    })
    .sort((left, right) => compareStrings(left.placeId, right.placeId));

  return {
    schemaVersion: NATIVE_CANDIDATE_SCHEMA_VERSION,
    generatedAt: snapshot.generatedAt,
    discoveryAnchor: { ...snapshot.discoveryAnchor },
    items,
    stores,
  };
}

export function toNativeCandidateSnapshot(
  snapshot: CandidateSnapshotV1,
): NativeContractSnapshot {
  return validateNativeCandidateSnapshot(snapshot);
}

export function buildNativeNotificationBody(
  itemTexts: readonly string[],
): string {
  const names = itemTexts.map((text) =>
    concise(normalizedWhitespace(text), NATIVE_MAX_DISPLAYED_ITEM_LENGTH),
  );
  const joined =
    names.length <= NATIVE_MAX_NAMED_ITEMS_IN_BODY
      ? names.join(' • ')
      : `${names.slice(0, NATIVE_MAX_NAMED_ITEMS_IN_BODY).join(' • ')} • +${
          names.length - NATIVE_MAX_NAMED_ITEMS_IN_BODY
        } more`;

  return concise(joined, NATIVE_MAX_NOTIFICATION_BODY_LENGTH);
}

export function selectNearestNativeStores(
  snapshot: NativeContractSnapshot,
): DesiredNativeStore[] {
  const validated = validateNativeCandidateSnapshot(snapshot);
  const itemsById = new Map(validated.items.map((item) => [item.id, item]));

  const ranked = collapseDuplicateStores(validated.stores)
    .flatMap((store) => {
      const items = store.itemIds
        .flatMap((itemId) => {
          const item = itemsById.get(itemId);
          return item ? [item] : [];
        })
        .sort((left, right) => compareStrings(left.id, right.id));
      if (items.length === 0) {
        return [];
      }

      const itemReferences = items.map((item) => ({
        id: item.id,
        revision: item.revision,
      }));

      return [
        {
          placeId: store.placeId,
          name: store.name,
          location: store.location,
          distanceMeters: distanceInMeters(
            validated.discoveryAnchor,
            store.location,
          ),
          itemReferences,
          itemIds: itemReferences.map((item) => item.id),
          title: concise(`At ${store.name}`, 100),
          body: buildNativeNotificationBody(items.map((item) => item.text)),
          fingerprintInput: {
            placeId: store.placeId,
            name: store.name,
            latitude: store.location.latitude,
            longitude: store.location.longitude,
            radiusMeters: NATIVE_GEOFENCE_RADIUS_METERS,
            items: items.map((item) => ({
              id: item.id,
              revision: item.revision,
              text: item.text,
            })),
          },
        },
      ];
    })
    .sort(
      (left, right) =>
        left.distanceMeters - right.distanceMeters ||
        compareStrings(left.placeId, right.placeId),
    );
  const remaining = [...ranked];
  const selected: DesiredNativeStore[] = [];
  const uncoveredItemIds = new Set(
    ranked.flatMap((store) => store.itemIds),
  );

  while (
    selected.length < NATIVE_MAX_MONITORED_STORES &&
    uncoveredItemIds.size > 0
  ) {
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

  selected.push(
    ...remaining.slice(0, NATIVE_MAX_MONITORED_STORES - selected.length),
  );

  return selected.sort(
    (left, right) =>
      left.distanceMeters - right.distanceMeters ||
      compareStrings(left.placeId, right.placeId),
  );
}

export function classifyNativeRequestTransition(input: {
  desired: DesiredNativeStore;
  existing?: {
    status: 'pending' | 'consumed';
    fingerprintInput: DesiredNativeStore['fingerprintInput'];
    itemReferences: NativeItemReference[];
    isPending: boolean;
  };
}): NativeRequestTransition {
  if (input.existing === undefined) {
    return 'add';
  }

  const sameItems =
    JSON.stringify(input.existing.itemReferences) ===
    JSON.stringify(input.desired.itemReferences);
  if (!sameItems) {
    return 'lifecycle-invalid';
  }

  const sameFingerprint =
    JSON.stringify(input.existing.fingerprintInput) ===
    JSON.stringify(input.desired.fingerprintInput);

  if (sameFingerprint && input.existing.status === 'consumed') {
    return 'consumed-same-fingerprint';
  }

  if (input.existing.status === 'pending' && sameFingerprint) {
    return input.existing.isPending ? 'unchanged' : 'add';
  }

  return 'content-change';
}
