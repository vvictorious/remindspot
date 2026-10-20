import { describe, expect, it } from 'vitest';

import type { NativeContractSnapshot } from './geofence-native-contract';
import {
  SMART_ARRIVAL_DELIVERY_IDENTIFIER_PREFIX,
  SMART_ARRIVAL_OBSERVATION_SECONDS,
  consumeSmartArrivalDeliveryIntent,
  decodeSmartArrivalPersistedState,
  encodeSmartArrivalPersistedState,
  invalidateSmartArrivalState,
  migrateSmartArrivalPersistedState,
  prepareSmartArrivalStateForPersistence,
  recoverSmartArrivalDeliveries,
  recoverSmartArrivalState,
  transitionSmartArrivalLocation,
  transitionSmartArrivalMotion,
  transitionSmartArrivalRegionEntry,
  type PersistedSmartArrivalRequest,
  type SmartArrivalLocationEvidence,
  type SmartArrivalPersistedState,
  type SmartArrivalPersistedStateV1,
} from './smart-arrival-state';

const STARTED_AT = '2026-10-20T16:01:54.475Z';
const STORE_A = { latitude: 34, longitude: -118 };
const STORE_B = { latitude: 34.002, longitude: -118 };
const OBSERVATION_A = '11111111-1111-4111-8111-111111111111';
const OBSERVATION_B = '22222222-2222-4222-8222-222222222222';

function at(millisecondsAfterStart: number): string {
  return new Date(Date.parse(STARTED_AT) + millisecondsAfterStart).toISOString();
}

function snapshot(): NativeContractSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-20T15:00:00.000Z',
    discoveryAnchor: STORE_A,
    items: [
      {
        id: 'item-milk',
        revision: 1,
        text: 'Milk',
        categories: ['grocery-store'],
      },
    ],
    stores: [
      {
        placeId: 'store-a',
        name: 'Store A',
        location: STORE_A,
        itemIds: ['item-milk'],
      },
      {
        placeId: 'store-b',
        name: 'Store B',
        location: STORE_B,
        itemIds: ['item-milk'],
      },
    ],
  };
}

function request(
  placeId: string,
  status: PersistedSmartArrivalRequest['status'] = 'pending',
): PersistedSmartArrivalRequest {
  return {
    placeId,
    installationId: `tyg.arrival.v1.${placeId}`,
    fingerprint: `fingerprint-${placeId}`,
    status,
    itemReferences: [{ id: 'item-milk', revision: 1 }],
  };
}

function state(
  requests: PersistedSmartArrivalRequest[] = [
    request('store-a'),
    request('store-b'),
  ],
): SmartArrivalPersistedState {
  return {
    schemaVersion: 2,
    snapshot: snapshot(),
    requests,
    pendingCancellations: [],
    observations: [],
    deliveryIntents: [],
  };
}

function enter(
  current: SmartArrivalPersistedState,
  placeId: 'store-a' | 'store-b',
): SmartArrivalPersistedState {
  return transitionSmartArrivalRegionEntry(current, {
    placeId,
    registrationId: `tyg.arrival.v1.${placeId}`,
    observationIdentifier:
      placeId === 'store-a' ? OBSERVATION_A : OBSERVATION_B,
    enteredAt: STARTED_AT,
  });
}

function location(
  coordinates: { latitude: number; longitude: number },
  millisecondsAfterStart: number,
  overrides: Partial<SmartArrivalLocationEvidence> = {},
): SmartArrivalLocationEvidence {
  const timestamp = at(millisecondsAfterStart);
  return {
    timestamp,
    receivedAt: timestamp,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    horizontalAccuracyMeters: 5,
    speedMetersPerSecond: 0,
    speedAccuracyMetersPerSecond: 0.5,
    ...overrides,
  };
}

function recordWalking(
  current: SmartArrivalPersistedState,
  millisecondsAfterStart: number,
  latestLocation: SmartArrivalLocationEvidence | null = null,
): SmartArrivalPersistedState {
  return transitionSmartArrivalMotion(
    current,
    {
      source: 'live',
      receivedAt: at(millisecondsAfterStart),
      activityStartedAt: at(millisecondsAfterStart - 100),
      automotive: false,
      walking: true,
      confidence: 'high',
    },
    latestLocation,
  );
}

describe('Smart Arrival persisted state migration', () => {
  it('migrates schema v1 without changing pending, consumed, snapshot, or cancellation state', () => {
    const previous: SmartArrivalPersistedStateV1 = {
      schemaVersion: 1,
      snapshot: snapshot(),
      requests: [request('store-a'), request('store-b', 'consumed')],
      pendingCancellations: [
        {
          placeId: 'retired-store',
          installationId: 'tyg.arrival.v1.retired-store',
        },
      ],
    };

    const migrated = migrateSmartArrivalPersistedState(previous);

    expect(migrated).toEqual({
      ...previous,
      schemaVersion: 2,
      observations: [],
      deliveryIntents: [],
    });
    expect(migrated.requests).toEqual(previous.requests);
    expect(migrated.pendingCancellations).toEqual(
      previous.pendingCancellations,
    );
  });

  it('decodes the actual JSON shape, including omitted v1 and optional observation fields', () => {
    const previousJson = JSON.stringify({
      schemaVersion: 1,
      snapshot: snapshot(),
      requests: [request('store-a'), request('store-b', 'consumed')],
    });
    const migrated = decodeSmartArrivalPersistedState(previousJson);

    expect(migrated.pendingCancellations).toEqual([]);
    expect(migrated.requests[1]?.status).toBe('consumed');

    const entered = enter(state(), 'store-a');
    const encoded = encodeSmartArrivalPersistedState(entered);
    const encodedObservation = (
      JSON.parse(encoded) as SmartArrivalPersistedState
    ).observations[0]!;

    expect(encodedObservation).not.toHaveProperty(
      'closestAccurateDistanceMeters',
    );
    expect(encodedObservation).not.toHaveProperty(
      'automotiveEvidenceStartedAt',
    );
    expect(encodedObservation).not.toHaveProperty(
      'walkingEvidenceStartedAt',
    );
    expect(decodeSmartArrivalPersistedState(encoded).observations).toEqual(
      entered.observations,
    );
  });
});

describe('Smart Arrival pure transitions', () => {
  it('starts one absolute observation and ignores duplicate or stale region callbacks', () => {
    const entered = enter(state(), 'store-a');
    const duplicate = transitionSmartArrivalRegionEntry(entered, {
      placeId: 'store-a',
      registrationId: 'tyg.arrival.v1.store-a',
      observationIdentifier: '33333333-3333-4333-8333-333333333333',
      enteredAt: at(1_000),
    });
    const stale = transitionSmartArrivalRegionEntry(entered, {
      placeId: 'store-b',
      registrationId: 'tyg.arrival.v1.old-store-b',
      observationIdentifier: '44444444-4444-4444-8444-444444444444',
      enteredAt: STARTED_AT,
    });
    const malformedIdentifier = transitionSmartArrivalRegionEntry(entered, {
      placeId: 'store-b',
      registrationId: 'tyg.arrival.v1.store-b',
      observationIdentifier: 'not-a-uuid',
      enteredAt: STARTED_AT,
    });

    expect(entered.observations).toHaveLength(1);
    expect(entered.observations[0]).toMatchObject({
      identifier: OBSERVATION_A,
      placeId: 'store-a',
      registrationId: 'tyg.arrival.v1.store-a',
      startedAt: STARTED_AT,
      deadline: at(SMART_ARRIVAL_OBSERVATION_SECONDS * 1000),
    });
    expect(duplicate).toEqual(entered);
    expect(stale).toEqual(entered);
    expect(malformedIdentifier).toEqual(entered);
  });

  it('rejects an observation identifier already used by another store', () => {
    const entered = enter(state(), 'store-a');
    const collision = transitionSmartArrivalRegionEntry(entered, {
      placeId: 'store-b',
      registrationId: 'tyg.arrival.v1.store-b',
      observationIdentifier: OBSERVATION_A,
      enteredAt: at(1_000),
    });

    expect(collision).toEqual(entered);
    expect(collision.observations).toHaveLength(1);
  });

  it('requires fresh accurate per-store proximity and keeps overlapping stores independent', () => {
    let current = enter(enter(state(), 'store-a'), 'store-b');
    current = recordWalking(
      current,
      10_000,
      location(STORE_A, 10_000, { horizontalAccuracyMeters: 20 }),
    );
    expect(current.deliveryIntents).toEqual([]);

    current = transitionSmartArrivalLocation(
      current,
      location(STORE_A, 10_000, {
        receivedAt: at(26_000),
      }),
    );
    expect(current.deliveryIntents).toEqual([]);

    current = transitionSmartArrivalLocation(
      current,
      location(STORE_A, 27_000),
    );
    expect(current.deliveryIntents.map((intent) => intent.placeId)).toEqual([
      'store-a',
    ]);
    expect(current.observations.map((observation) => observation.placeId)).toEqual([
      'store-b',
    ]);

    current = transitionSmartArrivalLocation(
      current,
      location(STORE_B, 28_000),
    );
    expect(current.deliveryIntents.map((intent) => intent.placeId)).toEqual([
      'store-a',
      'store-b',
    ]);
    expect(current.observations).toEqual([]);
    expect(
      current.deliveryIntents.every((intent) =>
        intent.notificationId.startsWith(
          SMART_ARRIVAL_DELIVERY_IDENTIFIER_PREFIX,
        ),
      ),
    ).toBe(true);
  });

  it('requires high-confidence walking that starts after entry', () => {
    const entered = enter(state(), 'store-a');
    const mediumConfidence = transitionSmartArrivalMotion(
      entered,
      {
        source: 'live',
        receivedAt: at(10_000),
        activityStartedAt: at(9_900),
        automotive: false,
        walking: true,
        confidence: 'medium',
      },
      location(STORE_A, 10_000),
    );
    const preEntryWalking = transitionSmartArrivalMotion(
      entered,
      {
        source: 'historical-query',
        receivedAt: at(10_000),
        activityStartedAt: at(-1),
        automotive: false,
        walking: true,
        confidence: 'high',
      },
      location(STORE_A, 10_000),
    );
    const futureWalking = transitionSmartArrivalMotion(
      entered,
      {
        source: 'live',
        receivedAt: at(10_000),
        activityStartedAt: at(10_001),
        automotive: false,
        walking: true,
        confidence: 'high',
      },
      location(STORE_A, 10_000),
    );

    expect(mediumConfidence.deliveryIntents).toEqual([]);
    expect(
      mediumConfidence.observations[0]?.walkingEvidenceStartedAt ?? null,
    ).toBeNull();
    expect(preEntryWalking.deliveryIntents).toEqual([]);
    expect(
      preEntryWalking.observations[0]?.walkingEvidenceStartedAt ?? null,
    ).toBeNull();
    expect(futureWalking.deliveryIntents).toEqual([]);
    expect(
      futureWalking.observations[0]?.walkingEvidenceStartedAt ?? null,
    ).toBeNull();
  });

  it('rejects pre-entry location evidence and accepts the exact entry boundary', () => {
    const entered = enter(state(), 'store-a');
    const walking = transitionSmartArrivalMotion(entered, {
      source: 'live',
      receivedAt: at(1_000),
      activityStartedAt: STARTED_AT,
      automotive: false,
      walking: true,
      confidence: 'high',
    });

    const predating = transitionSmartArrivalLocation(
      walking,
      location(STORE_A, 2_000, { timestamp: at(-1) }),
    );
    expect(predating.deliveryIntents).toEqual([]);
    expect(predating.observations).toHaveLength(1);

    const atEntry = transitionSmartArrivalLocation(
      walking,
      location(STORE_A, 2_000, { timestamp: STARTED_AT }),
    );
    expect(atEntry.deliveryIntents).toHaveLength(1);
  });

  it('creates separate intents when one shared sample qualifies two nearby stores', () => {
    const nearbyState = state();
    nearbyState.snapshot!.stores[1]!.location = {
      latitude: STORE_A.latitude + 0.0005,
      longitude: STORE_A.longitude,
    };
    const entered = enter(enter(nearbyState, 'store-a'), 'store-b');

    const qualified = recordWalking(
      entered,
      10_000,
      location(STORE_A, 10_000),
    );

    expect(qualified.observations).toEqual([]);
    expect(qualified.deliveryIntents.map((intent) => intent.placeId)).toEqual([
      'store-a',
      'store-b',
    ]);
    expect(new Set(qualified.deliveryIntents.map((intent) => intent.notificationId)).size).toBe(
      2,
    );
    expect(
      qualified.deliveryIntents.map((intent) => intent.registrationId),
    ).toEqual(['tyg.arrival.v1.store-a', 'tyg.arrival.v1.store-b']);
  });

  it('ends only on conservative drive-away evidence', () => {
    let current = enter(state(), 'store-a');
    current = transitionSmartArrivalLocation(
      current,
      location(STORE_A, 1_000),
    );
    current = transitionSmartArrivalMotion(current, {
      source: 'live',
      receivedAt: at(2_000),
      activityStartedAt: at(1_500),
      automotive: true,
      walking: false,
      confidence: 'high',
    });

    const tooSlow = transitionSmartArrivalLocation(
      current,
      location(
        { latitude: STORE_A.latitude + 0.0012, longitude: STORE_A.longitude },
        3_000,
        {
          speedMetersPerSecond: 3.9,
        },
      ),
    );
    expect(tooSlow.observations).toHaveLength(1);

    const inaccurateSpeed = transitionSmartArrivalLocation(
      current,
      location(
        { latitude: STORE_A.latitude + 0.0012, longitude: STORE_A.longitude },
        3_000,
        {
          speedMetersPerSecond: 8,
          speedAccuracyMetersPerSecond: 1.1,
        },
      ),
    );
    expect(inaccurateSpeed.observations).toHaveLength(1);

    const departed = transitionSmartArrivalLocation(
      current,
      location(
        { latitude: STORE_A.latitude + 0.0012, longitude: STORE_A.longitude },
        3_000,
        {
          speedMetersPerSecond: 8,
          speedAccuracyMetersPerSecond: 0.5,
        },
      ),
    );
    expect(departed.observations).toEqual([]);
    expect(departed.deliveryIntents).toEqual([]);
  });

  it('expires at the absolute 240-second deadline before considering walking', () => {
    const entered = enter(state(), 'store-a');
    const atDeadline = recordWalking(
      entered,
      SMART_ARRIVAL_OBSERVATION_SECONDS * 1000,
      location(STORE_A, SMART_ARRIVAL_OBSERVATION_SECONDS * 1000),
    );

    expect(atDeadline.observations).toEqual([]);
    expect(atDeadline.deliveryIntents).toEqual([]);
    expect(
      recoverSmartArrivalState(
        entered,
        at(SMART_ARRIVAL_OBSERVATION_SECONDS * 1000 - 1),
      ).observations,
    ).toHaveLength(1);
  });

  it('invalidates observations and unsent intents when their manifest fingerprint changes', () => {
    const entered = enter(state(), 'store-a');
    const invalidObservationState = {
      ...entered,
      requests: entered.requests.map((entry) =>
        entry.placeId === 'store-a'
          ? { ...entry, fingerprint: 'replacement-fingerprint' }
          : entry,
      ),
    };
    expect(
      invalidateSmartArrivalState(invalidObservationState).observations,
    ).toEqual([]);

    const withIntent = recordWalking(
      entered,
      10_000,
      location(STORE_A, 10_000),
    );
    const invalidIntentState = {
      ...withIntent,
      requests: withIntent.requests.map((entry) =>
        entry.placeId === 'store-a'
          ? { ...entry, fingerprint: 'replacement-fingerprint' }
          : entry,
      ),
    };
    expect(
      invalidateSmartArrivalState(invalidIntentState).deliveryIntents,
    ).toEqual([]);
  });

  it('invalidates an old fallback when the desired snapshot fingerprint changes', () => {
    const entered = enter(state(), 'store-a');
    const prepared = prepareSmartArrivalStateForPersistence(
      entered,
      new Map([
        ['store-a', 'new-snapshot-fingerprint'],
        ['store-b', 'fingerprint-store-b'],
      ]),
    );

    expect(prepared.observations).toEqual([]);
    expect(prepared.requests).toEqual(entered.requests);
    expect(prepared.snapshot).toEqual(entered.snapshot);
  });

  it('binds an intent to its registration and does not consume a replacement', () => {
    const withIntent = recordWalking(
      enter(state(), 'store-a'),
      10_000,
      location(STORE_A, 10_000),
    );
    const [intent] = withIntent.deliveryIntents;
    const replacementState: SmartArrivalPersistedState = {
      ...withIntent,
      requests: withIntent.requests.map((entry) =>
        entry.placeId === 'store-a'
          ? {
              ...entry,
              installationId: 'tyg.arrival.v1.store-a-replacement',
            }
          : entry,
      ),
    };

    expect(
      invalidateSmartArrivalState(replacementState).deliveryIntents,
    ).toEqual([]);

    const consumed = consumeSmartArrivalDeliveryIntent(
      replacementState,
      intent.notificationId,
    );
    expect(consumed.deliveryIntents).toEqual([]);
    expect(
      consumed.requests.find((entry) => entry.placeId === 'store-a')?.status,
    ).toBe('pending');
  });

  it('repairs stale reconciliation state before persistence and reload', () => {
    let active = enter(enter(state(), 'store-a'), 'store-b');
    active = recordWalking(
      active,
      10_000,
      location(STORE_B, 10_000),
    );
    active.pendingCancellations = [
      {
        placeId: 'retired-store',
        installationId: 'tyg.arrival.v1.retired-store',
      },
    ];

    const reconciled: SmartArrivalPersistedState = {
      ...active,
      requests: active.requests.map((entry) => {
        if (entry.placeId === 'store-a') {
          return {
            ...entry,
            installationId: 'tyg.arrival.v1.store-a-replacement',
          };
        }
        return { ...entry, status: 'consumed' };
      }),
    };
    const prepared = prepareSmartArrivalStateForPersistence(
      reconciled,
      new Map([
        ['store-a', 'replacement-fingerprint-store-a'],
        ['store-b', 'replacement-fingerprint-store-b'],
      ]),
    );
    const reloaded = decodeSmartArrivalPersistedState(
      encodeSmartArrivalPersistedState(prepared),
    );

    expect(reloaded.observations).toEqual([]);
    expect(reloaded.deliveryIntents).toEqual([]);
    expect(reloaded.snapshot).toEqual(reconciled.snapshot);
    expect(reloaded.requests).toEqual(reconciled.requests);
    expect(reloaded.pendingCancellations).toEqual(
      reconciled.pendingCancellations,
    );
    expect(
      reloaded.requests.find((entry) => entry.placeId === 'store-b')?.status,
    ).toBe('consumed');
  });

  it('makes pure recovery decisions from pending and delivered identifiers', () => {
    const withIntent = recordWalking(
      enter(state(), 'store-a'),
      10_000,
      location(STORE_A, 10_000),
    );
    const restored = decodeSmartArrivalPersistedState(
      encodeSmartArrivalPersistedState(withIntent),
    );
    const [intent] = restored.deliveryIntents;

    expect(intent).toMatchObject({
      placeId: 'store-a',
      fingerprint: 'fingerprint-store-a',
      registrationId: 'tyg.arrival.v1.store-a',
      notificationId:
        `${SMART_ARRIVAL_DELIVERY_IDENTIFIER_PREFIX}` +
        `${'tyg.arrival.v1.store-a'.length}:` +
        `tyg.arrival.v1.store-a.${OBSERVATION_A}`,
    });

    const unknown = recoverSmartArrivalDeliveries(restored, {
      now: at(20_000),
      pendingNotificationIds: [],
      deliveredNotificationIds: [],
    });
    expect(unknown.intentsToSubmit).toEqual([intent]);

    const pending = recoverSmartArrivalDeliveries(restored, {
      now: at(20_000),
      pendingNotificationIds: [intent.notificationId],
      deliveredNotificationIds: [],
    });
    expect(pending.intentsToSubmit).toEqual([]);
    expect(pending.pendingNotificationIds).toEqual([intent.notificationId]);
    expect(pending.state.deliveryIntents).toEqual([intent]);

    const delivered = recoverSmartArrivalDeliveries(restored, {
      now: at(20_000),
      pendingNotificationIds: [],
      deliveredNotificationIds: [intent.notificationId],
    });
    expect(delivered.state.deliveryIntents).toEqual([]);
    expect(delivered.consumedNotificationIds).toEqual([
      intent.notificationId,
    ]);
    expect(
      delivered.state.requests.find((entry) => entry.placeId === 'store-a')
        ?.status,
    ).toBe('consumed');
    expect(
      consumeSmartArrivalDeliveryIntent(
        delivered.state,
        intent.notificationId,
      ),
    ).toEqual(delivered.state);
  });
});
