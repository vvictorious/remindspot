import {
  NATIVE_GEOFENCE_RADIUS_METERS,
  type NativeContractSnapshot,
  type NativeItemReference,
} from './geofence-native-contract';

export const SMART_ARRIVAL_STATE_SCHEMA_VERSION = 2;
export const SMART_ARRIVAL_PREVIOUS_STATE_SCHEMA_VERSION = 1;
export const SMART_ARRIVAL_OBSERVATION_SECONDS = 240;
export const SMART_ARRIVAL_RADIUS_METERS = NATIVE_GEOFENCE_RADIUS_METERS;
export const SMART_ARRIVAL_FRESH_LOCATION_SECONDS = 15;
export const SMART_ARRIVAL_MAXIMUM_HORIZONTAL_ACCURACY_METERS = 15;
export const SMART_ARRIVAL_DRIVE_AWAY_MINIMUM_DISTANCE_METERS = 125;
export const SMART_ARRIVAL_DRIVE_AWAY_DISTANCE_INCREASE_METERS = 50;
export const SMART_ARRIVAL_DRIVE_AWAY_MINIMUM_SPEED_METERS_PER_SECOND = 4;
export const SMART_ARRIVAL_DRIVE_AWAY_MAXIMUM_SPEED_ACCURACY_METERS_PER_SECOND =
  1;
export const SMART_ARRIVAL_DELIVERY_IDENTIFIER_PREFIX =
  'tyg.arrival.delivery.v1.';

export type PersistedSmartArrivalRequest = {
  placeId: string;
  installationId: string;
  fingerprint: string;
  status: 'pending' | 'consumed';
  itemReferences: NativeItemReference[];
};

export type PersistedSmartArrivalCancellationIntent = {
  placeId: string;
  installationId: string;
};

export type PersistedSmartArrivalObservation = {
  identifier: string;
  placeId: string;
  registrationId: string;
  fingerprint: string;
  startedAt: string;
  deadline: string;
  closestAccurateDistanceMeters?: number | null;
  automotiveEvidenceStartedAt?: string | null;
  walkingEvidenceStartedAt?: string | null;
};

export type PersistedSmartArrivalDeliveryIntent = {
  placeId: string;
  observationIdentifier: string;
  registrationId: string;
  notificationId: string;
  fingerprint: string;
  createdAt: string;
};

export type SmartArrivalPersistedStateV1 = {
  schemaVersion: 1;
  snapshot: NativeContractSnapshot | null;
  requests: PersistedSmartArrivalRequest[];
  pendingCancellations?: PersistedSmartArrivalCancellationIntent[];
};

export type SmartArrivalPersistedState = {
  schemaVersion: 2;
  snapshot: NativeContractSnapshot | null;
  requests: PersistedSmartArrivalRequest[];
  pendingCancellations: PersistedSmartArrivalCancellationIntent[];
  observations: PersistedSmartArrivalObservation[];
  deliveryIntents: PersistedSmartArrivalDeliveryIntent[];
};

export type SmartArrivalLocationEvidence = {
  timestamp: string;
  receivedAt: string;
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number;
  speedMetersPerSecond: number | null;
  speedAccuracyMetersPerSecond: number | null;
};

export type SmartArrivalMotionEvidence = {
  source: 'live' | 'historical-query' | 'authorization-prompt';
  receivedAt: string;
  activityStartedAt: string;
  automotive: boolean;
  walking: boolean;
  confidence: 'low' | 'medium' | 'high';
};

export type SmartArrivalDeliveryRecovery = {
  state: SmartArrivalPersistedState;
  intentsToSubmit: PersistedSmartArrivalDeliveryIntent[];
  pendingNotificationIds: string[];
  consumedNotificationIds: string[];
};

export function migrateSmartArrivalPersistedState(
  state: SmartArrivalPersistedStateV1 | SmartArrivalPersistedState,
): SmartArrivalPersistedState {
  if (state.schemaVersion === SMART_ARRIVAL_STATE_SCHEMA_VERSION) {
    return validateSmartArrivalPersistedState(cloneState(state));
  }
  if (state.schemaVersion === SMART_ARRIVAL_PREVIOUS_STATE_SCHEMA_VERSION) {
    return validateSmartArrivalPersistedState({
      ...state,
      schemaVersion: SMART_ARRIVAL_STATE_SCHEMA_VERSION,
      pendingCancellations: state.pendingCancellations ?? [],
      observations: [],
      deliveryIntents: [],
    });
  }
  throw new Error('unsupported persisted Smart Arrival schemaVersion.');
}

export function decodeSmartArrivalPersistedState(
  json: string,
): SmartArrivalPersistedState {
  const parsed: unknown = JSON.parse(json);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('schemaVersion' in parsed)
  ) {
    throw new Error('persisted Smart Arrival state must be an object.');
  }
  return migrateSmartArrivalPersistedState(
    parsed as SmartArrivalPersistedStateV1 | SmartArrivalPersistedState,
  );
}

export function encodeSmartArrivalPersistedState(
  state: SmartArrivalPersistedState,
): string {
  const prepared = prepareSmartArrivalStateForPersistence(state);
  return JSON.stringify(prepared, (key, value: unknown) => {
    if (
      value === null &&
      (key === 'closestAccurateDistanceMeters' ||
        key === 'automotiveEvidenceStartedAt' ||
        key === 'walkingEvidenceStartedAt')
    ) {
      return undefined;
    }
    return value;
  });
}

export function validateSmartArrivalPersistedState(
  state: SmartArrivalPersistedState,
): SmartArrivalPersistedState {
  const requestsByPlaceId = new Map(
    state.requests.map((request) => [request.placeId, request]),
  );
  const snapshotPlaceIds = new Set(
    state.snapshot?.stores.map((store) => store.placeId) ?? [],
  );
  const observationIds = new Set<string>();
  const observationPlaceIds = new Set<string>();

  for (const observation of state.observations) {
    if (
      !isCanonicalObservationIdentifier(observation.identifier) ||
      observationIds.has(observation.identifier) ||
      observationPlaceIds.has(observation.placeId)
    ) {
      throw new Error(
        'observations must have unique identifiers and stores.',
      );
    }
    observationIds.add(observation.identifier);
    observationPlaceIds.add(observation.placeId);

    const startedAt = timestampMilliseconds(observation.startedAt);
    const deadline = timestampMilliseconds(observation.deadline);
    if (
      startedAt === null ||
      deadline === null ||
      deadline - startedAt !== SMART_ARRIVAL_OBSERVATION_SECONDS * 1000
    ) {
      throw new Error('an observation has an invalid absolute deadline.');
    }
    if (
      observation.closestAccurateDistanceMeters != null &&
      !isFiniteNonNegative(observation.closestAccurateDistanceMeters)
    ) {
      throw new Error('an observation has an invalid closest distance.');
    }
    for (const evidenceAt of [
      observation.automotiveEvidenceStartedAt ?? null,
      observation.walkingEvidenceStartedAt ?? null,
    ]) {
      if (evidenceAt === null) {
        continue;
      }
      const evidenceMilliseconds = timestampMilliseconds(evidenceAt);
      if (
        evidenceMilliseconds === null ||
        evidenceMilliseconds < startedAt ||
        evidenceMilliseconds >= deadline
      ) {
        throw new Error('an observation has invalid motion evidence.');
      }
    }

    const request = requestsByPlaceId.get(observation.placeId);
    if (
      !snapshotPlaceIds.has(observation.placeId) ||
      request?.status !== 'pending' ||
      request.installationId !== observation.registrationId ||
      request.fingerprint !== observation.fingerprint
    ) {
      throw new Error(
        'an observation does not match a pending manifest entry.',
      );
    }
  }

  const intentPlaceIds = new Set<string>();
  const intentObservationIds = new Set<string>();
  const notificationIds = new Set<string>();
  for (const intent of state.deliveryIntents) {
    const request = requestsByPlaceId.get(intent.placeId);
    if (
      intentPlaceIds.has(intent.placeId) ||
      intentObservationIds.has(intent.observationIdentifier) ||
      observationIds.has(intent.observationIdentifier) ||
      !isCanonicalObservationIdentifier(intent.observationIdentifier) ||
      notificationIds.has(intent.notificationId) ||
      intent.notificationId !==
        deliveryIdentifier(
          intent.registrationId,
          intent.observationIdentifier,
        ) ||
      timestampMilliseconds(intent.createdAt) === null ||
      observationPlaceIds.has(intent.placeId) ||
      !snapshotPlaceIds.has(intent.placeId) ||
      request?.status !== 'pending' ||
      request.installationId !== intent.registrationId ||
      request.fingerprint !== intent.fingerprint
    ) {
      throw new Error(
        'a delivery intent is duplicated or no longer matches the manifest.',
      );
    }
    intentPlaceIds.add(intent.placeId);
    intentObservationIds.add(intent.observationIdentifier);
    notificationIds.add(intent.notificationId);
  }

  return state;
}

export function transitionSmartArrivalRegionEntry(
  state: SmartArrivalPersistedState,
  input: {
    placeId: string;
    registrationId: string;
    observationIdentifier: string;
    enteredAt: string;
  },
): SmartArrivalPersistedState {
  const enteredAt = requiredTimestamp(input.enteredAt);
  const next = recoverSmartArrivalState(state, input.enteredAt);
  const request = next.requests.find(
    (candidate) => candidate.placeId === input.placeId,
  );
  const notificationId = deliveryIdentifier(
    input.registrationId,
    input.observationIdentifier,
  );

  if (
    !isCanonicalObservationIdentifier(input.observationIdentifier) ||
    next.observations.some(
      (observation) =>
        observation.identifier === input.observationIdentifier,
    ) ||
    next.deliveryIntents.some(
      (intent) =>
        intent.observationIdentifier === input.observationIdentifier ||
        intent.notificationId === notificationId,
    ) ||
    next.deliveryIntents.some((intent) => intent.placeId === input.placeId) ||
    next.observations.some(
      (observation) => observation.placeId === input.placeId,
    ) ||
    !next.snapshot?.stores.some((store) => store.placeId === input.placeId) ||
    request?.status !== 'pending' ||
    request.installationId !== input.registrationId
  ) {
    return next;
  }

  next.observations.push({
    identifier: input.observationIdentifier,
    placeId: input.placeId,
    registrationId: input.registrationId,
    fingerprint: request.fingerprint,
    startedAt: new Date(enteredAt).toISOString(),
    deadline: new Date(
      enteredAt + SMART_ARRIVAL_OBSERVATION_SECONDS * 1000,
    ).toISOString(),
  });
  sortTransientState(next);
  return next;
}

export function transitionSmartArrivalMotion(
  state: SmartArrivalPersistedState,
  evidence: SmartArrivalMotionEvidence,
  latestLocation: SmartArrivalLocationEvidence | null = null,
): SmartArrivalPersistedState {
  const receivedAt = requiredTimestamp(evidence.receivedAt);
  const activityStartedAt = requiredTimestamp(evidence.activityStartedAt);
  const next = recoverSmartArrivalState(state, evidence.receivedAt);

  if (
    (evidence.source !== 'live' &&
      evidence.source !== 'historical-query') ||
    evidence.confidence !== 'high' ||
    activityStartedAt > receivedAt
  ) {
    return next;
  }

  for (const observation of next.observations) {
    const startedAt = requiredTimestamp(observation.startedAt);
    const deadline = requiredTimestamp(observation.deadline);
    if (activityStartedAt < startedAt || activityStartedAt >= deadline) {
      continue;
    }
    if (evidence.automotive && !evidence.walking) {
      observation.automotiveEvidenceStartedAt = new Date(
        activityStartedAt,
      ).toISOString();
    }
    if (
      evidence.walking &&
      !evidence.automotive &&
      observation.walkingEvidenceStartedAt == null
    ) {
      observation.walkingEvidenceStartedAt = new Date(
        activityStartedAt,
      ).toISOString();
    }
  }

  return latestLocation === null
    ? next
    : applyLocation(next, latestLocation, receivedAt);
}

export function transitionSmartArrivalLocation(
  state: SmartArrivalPersistedState,
  evidence: SmartArrivalLocationEvidence,
): SmartArrivalPersistedState {
  return applyLocation(
    state,
    evidence,
    requiredTimestamp(evidence.receivedAt),
  );
}

export function invalidateSmartArrivalState(
  state: SmartArrivalPersistedState,
  desiredFingerprintsByPlaceId?: ReadonlyMap<string, string>,
): SmartArrivalPersistedState {
  const next = cloneState(state);
  const requestsByPlaceId = new Map(
    next.requests.map((request) => [request.placeId, request]),
  );
  const snapshotPlaceIds = new Set(
    next.snapshot?.stores.map((store) => store.placeId) ?? [],
  );

  next.observations = next.observations.filter((observation) => {
    const request = requestsByPlaceId.get(observation.placeId);
    return (
      snapshotPlaceIds.has(observation.placeId) &&
      request?.status === 'pending' &&
      request.installationId === observation.registrationId &&
      request.fingerprint === observation.fingerprint &&
      (desiredFingerprintsByPlaceId === undefined ||
        desiredFingerprintsByPlaceId.get(observation.placeId) ===
          observation.fingerprint)
    );
  });
  next.deliveryIntents = next.deliveryIntents.filter((intent) => {
    const request = requestsByPlaceId.get(intent.placeId);
    return (
      snapshotPlaceIds.has(intent.placeId) &&
      request?.status === 'pending' &&
      request.installationId === intent.registrationId &&
      request.fingerprint === intent.fingerprint &&
      (desiredFingerprintsByPlaceId === undefined ||
        desiredFingerprintsByPlaceId.get(intent.placeId) === intent.fingerprint)
    );
  });
  return next;
}

export function prepareSmartArrivalStateForPersistence(
  state: SmartArrivalPersistedState,
  desiredFingerprintsByPlaceId?: ReadonlyMap<string, string>,
): SmartArrivalPersistedState {
  const next = invalidateSmartArrivalState(
    state,
    desiredFingerprintsByPlaceId,
  );
  try {
    return validateSmartArrivalPersistedState(next);
  } catch {
    next.observations = [];
    next.deliveryIntents = [];
    return next;
  }
}

export function recoverSmartArrivalState(
  state: SmartArrivalPersistedState,
  now: string,
): SmartArrivalPersistedState {
  const nowMilliseconds = requiredTimestamp(now);
  const next = prepareSmartArrivalStateForPersistence(state);
  next.observations = next.observations.filter(
    (observation) =>
      nowMilliseconds < requiredTimestamp(observation.deadline),
  );
  return next;
}

export function recoverSmartArrivalDeliveries(
  state: SmartArrivalPersistedState,
  input: {
    now: string;
    pendingNotificationIds: readonly string[];
    deliveredNotificationIds: readonly string[];
  },
): SmartArrivalDeliveryRecovery {
  let next = recoverSmartArrivalState(state, input.now);
  const pendingIds = new Set(input.pendingNotificationIds);
  const deliveredIds = new Set(input.deliveredNotificationIds);
  const consumedNotificationIds: string[] = [];
  const consumedPendingNotificationIds: string[] = [];

  for (const intent of [...next.deliveryIntents]) {
    const isPending = pendingIds.has(intent.notificationId);
    const isDelivered = deliveredIds.has(intent.notificationId);
    if (!isPending && !isDelivered) {
      continue;
    }
    next = consumeSmartArrivalDeliveryIntent(next, intent.notificationId);
    consumedNotificationIds.push(intent.notificationId);
    if (isPending) {
      consumedPendingNotificationIds.push(intent.notificationId);
    }
  }

  return {
    state: next,
    intentsToSubmit: [...next.deliveryIntents].sort((left, right) =>
      compareStrings(left.registrationId, right.registrationId),
    ),
    pendingNotificationIds: consumedPendingNotificationIds.sort(compareStrings),
    consumedNotificationIds: consumedNotificationIds.sort(compareStrings),
  };
}

export function endSmartArrivalObservationsIfIneligible(
  state: SmartArrivalPersistedState,
  observationEligible: boolean,
): SmartArrivalPersistedState {
  if (observationEligible || state.observations.length === 0) {
    return state;
  }
  const next = cloneState(state);
  next.observations = [];
  return next;
}

export function smartArrivalStateAfterSubmission(
  state: SmartArrivalPersistedState,
  notificationId: string,
  succeeded: boolean,
): SmartArrivalPersistedState {
  if (!succeeded) {
    return state;
  }
  return consumeSmartArrivalDeliveryIntent(state, notificationId);
}

export function consumeSmartArrivalDeliveryIntent(
  state: SmartArrivalPersistedState,
  notificationId: string,
): SmartArrivalPersistedState {
  const next = cloneState(state);
  const intent = next.deliveryIntents.find(
    (candidate) => candidate.notificationId === notificationId,
  );
  if (intent === undefined) {
    return next;
  }

  const request = next.requests.find(
    (candidate) =>
      candidate.placeId === intent.placeId &&
      candidate.installationId === intent.registrationId &&
      candidate.fingerprint === intent.fingerprint,
  );
  if (request !== undefined) {
    request.status = 'consumed';
  }
  next.deliveryIntents = next.deliveryIntents.filter(
    (candidate) => candidate.notificationId !== notificationId,
  );
  next.observations = next.observations.filter(
    (observation) => observation.placeId !== intent.placeId,
  );
  return next;
}

function applyLocation(
  state: SmartArrivalPersistedState,
  evidence: SmartArrivalLocationEvidence,
  decisionAt: number,
): SmartArrivalPersistedState {
  const next = recoverSmartArrivalState(
    state,
    new Date(decisionAt).toISOString(),
  );
  if (!locationIsAccurateAndFresh(evidence, decisionAt)) {
    return next;
  }

  const storesByPlaceId = new Map(
    next.snapshot?.stores.map((store) => [store.placeId, store]) ?? [],
  );
  const retained: PersistedSmartArrivalObservation[] = [];
  const evidenceTimestamp = requiredTimestamp(evidence.timestamp);

  for (const observation of next.observations) {
    const store = storesByPlaceId.get(observation.placeId);
    if (store === undefined) {
      continue;
    }
    const observationStartedAt = requiredTimestamp(observation.startedAt);
    if (
      decisionAt < observationStartedAt ||
      evidenceTimestamp < observationStartedAt
    ) {
      retained.push(observation);
      continue;
    }
    const distanceMeters = distanceInMeters(
      { latitude: evidence.latitude, longitude: evidence.longitude },
      store.location,
    );
    const previousClosest =
      observation.closestAccurateDistanceMeters ?? null;
    observation.closestAccurateDistanceMeters =
      previousClosest === null
        ? distanceMeters
        : Math.min(previousClosest, distanceMeters);

    if (
      observation.automotiveEvidenceStartedAt != null &&
      previousClosest !== null &&
      locationQualifiesAsDriveAway(
        evidence,
        distanceMeters,
        previousClosest,
      )
    ) {
      continue;
    }

    if (
      observation.walkingEvidenceStartedAt != null &&
      distanceMeters <= SMART_ARRIVAL_RADIUS_METERS
    ) {
      next.deliveryIntents.push({
        placeId: observation.placeId,
        observationIdentifier: observation.identifier,
        registrationId: observation.registrationId,
        notificationId: deliveryIdentifier(
          observation.registrationId,
          observation.identifier,
        ),
        fingerprint: observation.fingerprint,
        createdAt: new Date(decisionAt).toISOString(),
      });
      continue;
    }

    retained.push(observation);
  }

  next.observations = retained;
  sortTransientState(next);
  return next;
}

function locationQualifiesAsDriveAway(
  evidence: SmartArrivalLocationEvidence,
  distanceMeters: number,
  previousClosestDistanceMeters: number,
): boolean {
  return (
    evidence.speedMetersPerSecond !== null &&
    Number.isFinite(evidence.speedMetersPerSecond) &&
    evidence.speedMetersPerSecond >=
      SMART_ARRIVAL_DRIVE_AWAY_MINIMUM_SPEED_METERS_PER_SECOND &&
    evidence.speedAccuracyMetersPerSecond !== null &&
    isFiniteNonNegative(evidence.speedAccuracyMetersPerSecond) &&
    evidence.speedAccuracyMetersPerSecond <=
      SMART_ARRIVAL_DRIVE_AWAY_MAXIMUM_SPEED_ACCURACY_METERS_PER_SECOND &&
    distanceMeters >= SMART_ARRIVAL_DRIVE_AWAY_MINIMUM_DISTANCE_METERS &&
    distanceMeters >=
      previousClosestDistanceMeters +
        SMART_ARRIVAL_DRIVE_AWAY_DISTANCE_INCREASE_METERS
  );
}

function locationIsAccurateAndFresh(
  evidence: SmartArrivalLocationEvidence,
  nowMilliseconds: number,
): boolean {
  const timestamp = timestampMilliseconds(evidence.timestamp);
  const ageMilliseconds =
    timestamp === null ? Number.POSITIVE_INFINITY : nowMilliseconds - timestamp;
  return (
    isValidCoordinates(evidence.latitude, evidence.longitude) &&
    isFiniteNonNegative(evidence.horizontalAccuracyMeters) &&
    evidence.horizontalAccuracyMeters <=
      SMART_ARRIVAL_MAXIMUM_HORIZONTAL_ACCURACY_METERS &&
    ageMilliseconds >= 0 &&
    ageMilliseconds <= SMART_ARRIVAL_FRESH_LOCATION_SECONDS * 1000
  );
}

function deliveryIdentifier(
  registrationId: string,
  observationIdentifier: string,
): string {
  return `${SMART_ARRIVAL_DELIVERY_IDENTIFIER_PREFIX}${registrationId.length}:${registrationId}.${observationIdentifier}`;
}

function cloneState(
  state: SmartArrivalPersistedState,
): SmartArrivalPersistedState {
  return {
    ...state,
    requests: state.requests.map((request) => ({
      ...request,
      itemReferences: request.itemReferences.map((item) => ({ ...item })),
    })),
    pendingCancellations: state.pendingCancellations.map((intent) => ({
      ...intent,
    })),
    observations: state.observations.map((observation) => ({
      ...observation,
    })),
    deliveryIntents: state.deliveryIntents.map((intent) => ({ ...intent })),
  };
}

function sortTransientState(state: SmartArrivalPersistedState): void {
  state.observations.sort((left, right) =>
    compareStrings(left.registrationId, right.registrationId),
  );
  state.deliveryIntents.sort((left, right) =>
    compareStrings(left.registrationId, right.registrationId),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalObservationIdentifier(identifier: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    identifier,
  );
}

function requiredTimestamp(value: string): number {
  const timestamp = timestampMilliseconds(value);
  if (timestamp === null) {
    throw new Error(`invalid canonical timestamp: ${value}`);
  }
  return timestamp;
}

function timestampMilliseconds(value: string): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function isValidCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function distanceInMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
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
