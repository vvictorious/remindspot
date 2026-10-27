import { DESTINATION_CATEGORIES } from '../models/Classification';
import type { Item } from '../models/Item';

// Portable contract for native background discovery. Swift copies these
// constants and decisions. Distance checks here use haversine; Swift uses
// CLLocation.distance. Tests stay off exact boundaries.

export const BACKGROUND_DISCOVERY_SCHEMA_VERSION = 1;
export const BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS = 1_000;
export const BACKGROUND_DISCOVERY_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
export const BACKGROUND_DISCOVERY_REQUEST_TIMEOUT_MS = 10_000;
export const BACKGROUND_DISCOVERY_ABANDONED_IN_FLIGHT_MS = 2 * 60 * 1000;
export const BACKGROUND_DISCOVERY_STORE_RADIUS_METERS = 100;
export const BACKGROUND_DISCOVERY_MAXIMUM_VISIT_ACCURACY_METERS = 100;

const categoryOrder = new Map(
  DESTINATION_CATEGORIES.map((category, index) => [category, index]),
);

export type BackgroundDiscoveryCoordinate = {
  latitude: number;
  longitude: number;
};

export type BackgroundDiscoveryItem = {
  id: string;
  revision: number;
  text: string;
  taxonomyVersion: number;
  categories: readonly string[];
};

export type BackgroundDiscoverySkipReason =
  | 'not-arrival'
  | 'app-active'
  | 'authorization'
  | 'invalid-coordinate'
  | 'empty-items'
  | 'missing-api-url'
  | 'duplicate-arrival'
  | 'in-flight'
  | 'unchanged-nearby-anchor'
  | 'failure-cooldown';

export type BackgroundDiscoveryDecision =
  | { action: 'search' }
  | { action: 'skip'; reason: BackgroundDiscoverySkipReason };

export type BackgroundDiscoveryAttempt = {
  inFlightStartedAt: Date | null;
  inFlightLatitude: number | null;
  inFlightLongitude: number | null;
  inFlightItemSignature: string | null;
  lastArrivalKey: string | null;
  lastFailureAt: Date | null;
  lastFailureLatitude: number | null;
  lastFailureLongitude: number | null;
  lastFailureItemSignature: string | null;
};

export type BackgroundDiscoveryAnchor = {
  itemSignature: string;
  latitude: number;
  longitude: number;
};

export type BackgroundDiscoveryDecisionInput = {
  now: Date;
  appState: 'active' | 'background' | 'inactive';
  allowForeground: boolean;
  authorization: 'always-precise' | 'unavailable';
  arrivalKnown: boolean;
  departed: boolean;
  coordinateValid: boolean;
  latitude: number;
  longitude: number;
  arrivalKey: string;
  items: readonly BackgroundDiscoveryItem[];
  apiBaseUrl: string | null;
  attempt: BackgroundDiscoveryAttempt;
  anchor: BackgroundDiscoveryAnchor | null;
};

export type BackgroundDiscoveryResponseOutcome =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'timeout'
  | 'network'
  | 'http'
  | 'cancelled'
  | 'expired'
  | 'invalid';

export type BackgroundDiscoveryResponseGate = {
  cancelled: boolean;
  expired: boolean;
  timedOut: boolean;
  networkError: boolean;
  httpStatus: number | null;
  decodedStatus: 'complete' | 'partial' | 'failed' | null;
  consistent: boolean;
};

export type BackgroundDiscoveryDiscardInput = {
  requestStartedAt: Date;
  requestItemSignature: string;
  visit: BackgroundDiscoveryCoordinate;
  persisted: {
    generatedAt: Date;
    itemSignature: string;
    latitude: number;
    longitude: number;
  } | null;
};

export type AlreadyNearbyStore = {
  placeId: string;
  latitude: number;
  longitude: number;
  selected: boolean;
  pending: boolean;
  newlyScheduled: boolean;
};

export type BackgroundDiscoveryCommitPlan = {
  reconcile: boolean;
  observe: boolean;
  rollBack: boolean;
};

export function backgroundDiscoveryDistanceMeters(
  left: BackgroundDiscoveryCoordinate,
  right: BackgroundDiscoveryCoordinate,
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

function sortedCategories(categories: readonly string[]): string[] {
  return [...categories].sort(
    (left, right) =>
      (categoryOrder.get(left as (typeof DESTINATION_CATEGORIES)[number]) ??
        Number.MAX_SAFE_INTEGER) -
      (categoryOrder.get(right as (typeof DESTINATION_CATEGORIES)[number]) ??
        Number.MAX_SAFE_INTEGER),
  );
}

function canonicalItems(items: readonly BackgroundDiscoveryItem[]) {
  return [...items]
    .map((item) => ({
      id: item.id,
      revision: item.revision,
      text: item.text,
      taxonomyVersion: item.taxonomyVersion,
      categories: sortedCategories(item.categories),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function backgroundDiscoveryItemSignature(
  items: readonly BackgroundDiscoveryItem[],
): string {
  return JSON.stringify(canonicalItems(items));
}

export function backgroundDiscoveryPlaceItemsSignature(
  items: readonly {
    id: string;
    revision: number;
    taxonomyVersion: number;
    categories: readonly string[];
  }[],
): string {
  return JSON.stringify(
    [...items]
      .map((item) => ({
        id: item.id,
        revision: item.revision,
        taxonomyVersion: item.taxonomyVersion,
        categories: sortedCategories(item.categories),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function emptyBackgroundDiscoveryAttempt(): BackgroundDiscoveryAttempt {
  return {
    inFlightStartedAt: null,
    inFlightLatitude: null,
    inFlightLongitude: null,
    inFlightItemSignature: null,
    lastArrivalKey: null,
    lastFailureAt: null,
    lastFailureLatitude: null,
    lastFailureLongitude: null,
    lastFailureItemSignature: null,
  };
}

function effectiveFailure(
  attempt: BackgroundDiscoveryAttempt,
  now: Date,
): {
  at: Date;
  latitude: number;
  longitude: number;
  itemSignature: string;
} | null {
  if (attempt.inFlightStartedAt !== null) {
    const age = now.getTime() - attempt.inFlightStartedAt.getTime();
    if (age >= BACKGROUND_DISCOVERY_ABANDONED_IN_FLIGHT_MS) {
      if (
        attempt.inFlightLatitude === null ||
        attempt.inFlightLongitude === null ||
        attempt.inFlightItemSignature === null
      ) {
        return null;
      }
      return {
        at: attempt.inFlightStartedAt,
        latitude: attempt.inFlightLatitude,
        longitude: attempt.inFlightLongitude,
        itemSignature: attempt.inFlightItemSignature,
      };
    }
  }

  if (
    attempt.lastFailureAt === null ||
    attempt.lastFailureLatitude === null ||
    attempt.lastFailureLongitude === null ||
    attempt.lastFailureItemSignature === null
  ) {
    return null;
  }

  return {
    at: attempt.lastFailureAt,
    latitude: attempt.lastFailureLatitude,
    longitude: attempt.lastFailureLongitude,
    itemSignature: attempt.lastFailureItemSignature,
  };
}

export function decideBackgroundDiscovery(
  input: BackgroundDiscoveryDecisionInput,
): BackgroundDiscoveryDecision {
  const isArrival = input.arrivalKnown && !input.departed;
  if (!isArrival) {
    return { action: 'skip', reason: 'not-arrival' };
  }
  if (input.appState === 'active' && !input.allowForeground) {
    return { action: 'skip', reason: 'app-active' };
  }
  if (input.authorization !== 'always-precise') {
    return { action: 'skip', reason: 'authorization' };
  }
  if (
    !input.coordinateValid ||
    !Number.isFinite(input.latitude) ||
    !Number.isFinite(input.longitude)
  ) {
    return { action: 'skip', reason: 'invalid-coordinate' };
  }
  if (input.items.length === 0) {
    return { action: 'skip', reason: 'empty-items' };
  }
  if (input.apiBaseUrl === null || input.apiBaseUrl.trim().length === 0) {
    return { action: 'skip', reason: 'missing-api-url' };
  }
  if (
    input.attempt.lastArrivalKey !== null &&
    input.attempt.lastArrivalKey === input.arrivalKey
  ) {
    return { action: 'skip', reason: 'duplicate-arrival' };
  }
  if (input.attempt.inFlightStartedAt !== null) {
    const age = input.now.getTime() - input.attempt.inFlightStartedAt.getTime();
    if (age >= 0 && age < BACKGROUND_DISCOVERY_ABANDONED_IN_FLIGHT_MS) {
      return { action: 'skip', reason: 'in-flight' };
    }
  }

  const visit = { latitude: input.latitude, longitude: input.longitude };
  const currentSignature = backgroundDiscoveryItemSignature(input.items);
  if (
    input.anchor !== null &&
    input.anchor.itemSignature === currentSignature &&
    backgroundDiscoveryDistanceMeters(visit, input.anchor) <
      BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS
  ) {
    return { action: 'skip', reason: 'unchanged-nearby-anchor' };
  }

  const failure = effectiveFailure(input.attempt, input.now);
  if (failure !== null && failure.itemSignature === currentSignature) {
    const age = input.now.getTime() - failure.at.getTime();
    const distance = backgroundDiscoveryDistanceMeters(visit, failure);
    if (
      age >= 0 &&
      age < BACKGROUND_DISCOVERY_FAILURE_COOLDOWN_MS &&
      distance < BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS
    ) {
      return { action: 'skip', reason: 'failure-cooldown' };
    }
  }

  return { action: 'search' };
}

export function classifyBackgroundResponse(
  gate: BackgroundDiscoveryResponseGate,
): BackgroundDiscoveryResponseOutcome {
  if (gate.expired) {
    return 'expired';
  }
  if (gate.cancelled) {
    return 'cancelled';
  }
  if (gate.timedOut) {
    return 'timeout';
  }
  if (gate.networkError || gate.httpStatus === null) {
    return 'network';
  }
  if (gate.httpStatus !== 200) {
    return 'http';
  }
  if (gate.decodedStatus === null || !gate.consistent) {
    return 'invalid';
  }
  return gate.decodedStatus;
}

export function shouldApplyBackgroundResponse(
  outcome: BackgroundDiscoveryResponseOutcome,
): boolean {
  return outcome === 'complete';
}

export function shouldCommitDiscoveredItems(input: {
  requestItemSignature: string;
  currentItems: readonly BackgroundDiscoveryItem[];
}): boolean {
  return (
    backgroundDiscoveryItemSignature(input.currentItems) ===
    input.requestItemSignature
  );
}

export function shouldRecordFailureCooldown(outcome: string): boolean {
  return outcome !== 'input-changed';
}

export function shouldDiscardBackgroundResponse(
  input: BackgroundDiscoveryDiscardInput,
): boolean {
  if (input.persisted === null) {
    return false;
  }
  if (input.persisted.generatedAt.getTime() <= input.requestStartedAt.getTime()) {
    return false;
  }

  const signatureDiffers =
    input.persisted.itemSignature !== input.requestItemSignature;
  const anchorNearby =
    backgroundDiscoveryDistanceMeters(input.visit, input.persisted) <
    BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS;
  return signatureDiffers || anchorNearby;
}

export function nextBackgroundSnapshotGeneratedAt(
  now: Date,
  previousGeneratedAt: Date | null,
): Date {
  const previous = previousGeneratedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return new Date(Math.max(now.getTime(), previous + 1));
}

export function alreadyNearbyStoreIds(input: {
  visitAccuracyMeters: number;
  visit: BackgroundDiscoveryCoordinate;
  stores: readonly AlreadyNearbyStore[];
}): string[] {
  if (
    !Number.isFinite(input.visitAccuracyMeters) ||
    input.visitAccuracyMeters < 0 ||
    input.visitAccuracyMeters > BACKGROUND_DISCOVERY_MAXIMUM_VISIT_ACCURACY_METERS
  ) {
    return [];
  }

  const limit =
    BACKGROUND_DISCOVERY_STORE_RADIUS_METERS + input.visitAccuracyMeters;
  return input.stores
    .filter(
      (store) =>
        store.selected &&
        store.pending &&
        store.newlyScheduled &&
        backgroundDiscoveryDistanceMeters(input.visit, store) <= limit,
    )
    .map((store) => store.placeId);
}

export function backgroundDiscoveryCommitPlan(input: {
  expiredOrCancelledBeforeReconcile: boolean;
  expiredOrCancelledAfterReconcile: boolean;
}): BackgroundDiscoveryCommitPlan {
  if (input.expiredOrCancelledBeforeReconcile) {
    return { reconcile: false, observe: false, rollBack: false };
  }
  if (input.expiredOrCancelledAfterReconcile) {
    return { reconcile: true, observe: false, rollBack: false };
  }
  return { reconcile: true, observe: true, rollBack: false };
}

export function backgroundDiscoveryItemsFromItems(
  items: readonly Item[],
): BackgroundDiscoveryItem[] {
  return items.flatMap((item) => {
    if (item.completedAt !== undefined) {
      return [];
    }
    const { classification } = item;
    if (
      classification.status !== 'current' ||
      classification.sourceRevision !== item.revision ||
      classification.result.outcome !== 'classified'
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        revision: item.revision,
        text: item.text,
        taxonomyVersion: classification.result.taxonomyVersion,
        categories: [...classification.result.categories],
      },
    ];
  });
}

export function isStaleSnapshotError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('stale-snapshot');
}
