import { describe, expect, it } from 'vitest';

import { completeItem } from '../models/item-transitions';
import { DESTINATION_TAXONOMY_VERSION } from '../models/Classification';
import type { Item } from '../models/Item';
import {
  alreadyNearbyStoreIds,
  backgroundDiscoveryCommitPlan,
  backgroundDiscoveryDistanceMeters,
  backgroundDiscoveryItemSignature,
  backgroundDiscoveryItemsFromItems,
  backgroundDiscoveryPlaceItemsSignature,
  BACKGROUND_DISCOVERY_ABANDONED_IN_FLIGHT_MS,
  BACKGROUND_DISCOVERY_FAILURE_COOLDOWN_MS,
  BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS,
  classifyBackgroundResponse,
  decideBackgroundDiscovery,
  emptyBackgroundDiscoveryAttempt,
  nextBackgroundSnapshotGeneratedAt,
  shouldApplyBackgroundResponse,
  shouldCommitDiscoveredItems,
  shouldDiscardBackgroundResponse,
  shouldRecordFailureCooldown,
  type BackgroundDiscoveryAttempt,
  type BackgroundDiscoveryDecisionInput,
  type BackgroundDiscoveryItem,
  type BackgroundDiscoveryResponseGate,
} from './background-discovery';

const NOW = new Date('2026-10-23T18:00:00.000Z');
const ORIGIN = { latitude: 34.02, longitude: -118.42 };

const milk: BackgroundDiscoveryItem = {
  id: 'milk',
  revision: 1,
  text: 'Milk',
  taxonomyVersion: 1,
  categories: ['grocery-store'],
};

const film: BackgroundDiscoveryItem = {
  id: 'film',
  revision: 2,
  text: 'Photo paper',
  taxonomyVersion: 1,
  categories: ['department-store', 'electronics-store'],
};

function offsetLatitude(meters: number): number {
  return ORIGIN.latitude + meters / 111_320;
}

function decisionInput(
  overrides: Partial<BackgroundDiscoveryDecisionInput> = {},
): BackgroundDiscoveryDecisionInput {
  return {
    now: NOW,
    appState: 'background',
    allowForeground: false,
    authorization: 'always-precise',
    arrivalKnown: true,
    departed: false,
    coordinateValid: true,
    latitude: ORIGIN.latitude,
    longitude: ORIGIN.longitude,
    arrivalKey: 'arrival-1',
    items: [milk],
    apiBaseUrl: 'http://192.168.1.20:3000',
    attempt: emptyBackgroundDiscoveryAttempt(),
    anchor: null,
    ...overrides,
  };
}

function attempt(
  overrides: Partial<BackgroundDiscoveryAttempt>,
): BackgroundDiscoveryAttempt {
  return { ...emptyBackgroundDiscoveryAttempt(), ...overrides };
}

function completeGate(
  overrides: Partial<BackgroundDiscoveryResponseGate> = {},
): BackgroundDiscoveryResponseGate {
  return {
    cancelled: false,
    expired: false,
    timedOut: false,
    networkError: false,
    httpStatus: 200,
    decodedStatus: 'complete',
    consistent: true,
    ...overrides,
  };
}

describe('background discovery decisions', () => {
  it('builds stable item signatures, including category order and escaping', () => {
    expect(backgroundDiscoveryItemSignature([milk, film])).toBe(
      '[{"id":"film","revision":2,"text":"Photo paper","taxonomyVersion":1,"categories":["electronics-store","department-store"]},{"id":"milk","revision":1,"text":"Milk","taxonomyVersion":1,"categories":["grocery-store"]}]',
    );
    expect(
      backgroundDiscoveryPlaceItemsSignature([
        {
          id: 'film',
          revision: 2,
          taxonomyVersion: 1,
          categories: ['department-store', 'electronics-store'],
        },
        milk,
      ]),
    ).toBe(
      '[{"id":"film","revision":2,"taxonomyVersion":1,"categories":["electronics-store","department-store"]},{"id":"milk","revision":1,"taxonomyVersion":1,"categories":["grocery-store"]}]',
    );
    expect(
      backgroundDiscoveryItemSignature([
        { ...milk, id: 'q', text: 'Say "hi"' },
      ]),
    ).toBe(
      '[{"id":"q","revision":1,"text":"Say \\"hi\\"","taxonomyVersion":1,"categories":["grocery-store"]}]',
    );
  });

  it('searches a real background arrival and skips every other visit shape', () => {
    expect(decideBackgroundDiscovery(decisionInput())).toEqual({
      action: 'search',
    });
    expect(
      decideBackgroundDiscovery(
        decisionInput({ arrivalKnown: false, departed: true }),
      ),
    ).toEqual({ action: 'skip', reason: 'not-arrival' });
    expect(
      decideBackgroundDiscovery(
        decisionInput({ arrivalKnown: true, departed: true }),
      ),
    ).toEqual({ action: 'skip', reason: 'not-arrival' });
    expect(
      decideBackgroundDiscovery(
        decisionInput({ arrivalKnown: false, departed: false }),
      ),
    ).toEqual({ action: 'skip', reason: 'not-arrival' });
  });

  it('skips foreground, unauthorized, invalid, empty, and unconfigured arrivals', () => {
    expect(
      decideBackgroundDiscovery(decisionInput({ appState: 'active' })),
    ).toEqual({ action: 'skip', reason: 'app-active' });
    expect(
      decideBackgroundDiscovery(
        decisionInput({ appState: 'inactive' }),
      ).action,
    ).toBe('search');
    expect(
      decideBackgroundDiscovery(
        decisionInput({ appState: 'active', allowForeground: true }),
      ).action,
    ).toBe('search');
    expect(
      decideBackgroundDiscovery(
        decisionInput({ authorization: 'unavailable' }),
      ),
    ).toEqual({ action: 'skip', reason: 'authorization' });
    expect(
      decideBackgroundDiscovery(decisionInput({ coordinateValid: false })),
    ).toEqual({ action: 'skip', reason: 'invalid-coordinate' });
    expect(decideBackgroundDiscovery(decisionInput({ items: [] }))).toEqual({
      action: 'skip',
      reason: 'empty-items',
    });
    expect(
      decideBackgroundDiscovery(decisionInput({ apiBaseUrl: '  ' })),
    ).toEqual({ action: 'skip', reason: 'missing-api-url' });
  });

  it('deduplicates a handled arrival and a young in-flight request', () => {
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          attempt: attempt({ lastArrivalKey: 'arrival-1' }),
        }),
      ),
    ).toEqual({ action: 'skip', reason: 'duplicate-arrival' });
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          arrivalKey: 'arrival-2',
          attempt: attempt({
            inFlightStartedAt: new Date(
              NOW.getTime() - BACKGROUND_DISCOVERY_ABANDONED_IN_FLIGHT_MS + 1_000,
            ),
            inFlightLatitude: ORIGIN.latitude,
            inFlightLongitude: ORIGIN.longitude,
            inFlightItemSignature: backgroundDiscoveryItemSignature([milk]),
          }),
        }),
      ),
    ).toEqual({ action: 'skip', reason: 'in-flight' });
  });

  it('reuses a nearby anchor for the same items and searches when items or distance change', () => {
    const signature = backgroundDiscoveryItemSignature([milk]);
    const nearby = offsetLatitude(400);
    expect(
      backgroundDiscoveryDistanceMeters(ORIGIN, {
        latitude: nearby,
        longitude: ORIGIN.longitude,
      }),
    ).toBeLessThan(BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS);
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          latitude: nearby,
          anchor: { itemSignature: signature, ...ORIGIN },
        }),
      ),
    ).toEqual({ action: 'skip', reason: 'unchanged-nearby-anchor' });

    const far = offsetLatitude(2_200);
    expect(
      backgroundDiscoveryDistanceMeters(ORIGIN, {
        latitude: far,
        longitude: ORIGIN.longitude,
      }),
    ).toBeGreaterThan(BACKGROUND_DISCOVERY_REUSE_DISTANCE_METERS);
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          latitude: far,
          anchor: { itemSignature: signature, ...ORIGIN },
        }),
      ).action,
    ).toBe('search');
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          items: [{ ...milk, revision: 2 }],
          anchor: { itemSignature: signature, ...ORIGIN },
        }),
      ).action,
    ).toBe('search');
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          anchor: null,
        }),
      ).action,
    ).toBe('search');
  });

  it('cools down a recent nearby failure and does not treat an abandoned lock as its own retry', () => {
    const signature = backgroundDiscoveryItemSignature([milk]);
    const recentFailure = attempt({
      lastFailureAt: new Date(NOW.getTime() - 60_000),
      lastFailureLatitude: ORIGIN.latitude,
      lastFailureLongitude: ORIGIN.longitude,
      lastFailureItemSignature: signature,
    });
    expect(
      decideBackgroundDiscovery(decisionInput({ attempt: recentFailure })),
    ).toEqual({ action: 'skip', reason: 'failure-cooldown' });
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          latitude: offsetLatitude(2_200),
          attempt: recentFailure,
        }),
      ).action,
    ).toBe('search');
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          items: [{ ...milk, text: 'Oat milk' }],
          attempt: recentFailure,
        }),
      ).action,
    ).toBe('search');
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          attempt: attempt({
            lastFailureAt: new Date(
              NOW.getTime() - BACKGROUND_DISCOVERY_FAILURE_COOLDOWN_MS - 1_000,
            ),
            lastFailureLatitude: ORIGIN.latitude,
            lastFailureLongitude: ORIGIN.longitude,
            lastFailureItemSignature: signature,
          }),
        }),
      ).action,
    ).toBe('search');

    const abandoned = attempt({
      inFlightStartedAt: new Date(NOW.getTime() - 3 * 60 * 1000),
      inFlightLatitude: ORIGIN.latitude,
      inFlightLongitude: ORIGIN.longitude,
      inFlightItemSignature: signature,
    });
    expect(
      decideBackgroundDiscovery(decisionInput({ attempt: abandoned })),
    ).toEqual({ action: 'skip', reason: 'failure-cooldown' });
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          attempt: attempt({
            ...abandoned,
            inFlightStartedAt: new Date(
              NOW.getTime() - BACKGROUND_DISCOVERY_FAILURE_COOLDOWN_MS - 5_000,
            ),
          }),
        }),
      ).action,
    ).toBe('search');
  });

  it('applies only a consistent complete response', () => {
    const outcomes = [
      'complete',
      'partial',
      'failed',
      'timeout',
      'network',
      'http',
      'cancelled',
      'expired',
      'invalid',
    ] as const;
    expect(
      outcomes.filter((outcome) => shouldApplyBackgroundResponse(outcome)),
    ).toEqual(['complete']);
    expect(classifyBackgroundResponse(completeGate())).toBe('complete');
    expect(
      classifyBackgroundResponse(completeGate({ decodedStatus: 'partial' })),
    ).toBe('partial');
    expect(
      classifyBackgroundResponse(completeGate({ decodedStatus: 'failed' })),
    ).toBe('failed');
    expect(
      classifyBackgroundResponse(completeGate({ consistent: false })),
    ).toBe('invalid');
    expect(classifyBackgroundResponse(completeGate({ timedOut: true }))).toBe(
      'timeout',
    );
    expect(
      classifyBackgroundResponse(completeGate({ networkError: true })),
    ).toBe('network');
    expect(classifyBackgroundResponse(completeGate({ httpStatus: 503 }))).toBe(
      'http',
    );
    expect(classifyBackgroundResponse(completeGate({ cancelled: true }))).toBe(
      'cancelled',
    );
    expect(
      classifyBackgroundResponse(
        completeGate({ cancelled: true, expired: true }),
      ),
    ).toBe('expired');
  });

  it('discards a response when a newer snapshot changed items or already covers the visit', () => {
    const signature = backgroundDiscoveryItemSignature([milk]);
    const requestStartedAt = new Date(NOW.getTime() - 5_000);
    const base = {
      requestStartedAt,
      requestItemSignature: signature,
      visit: ORIGIN,
    };
    expect(
      shouldDiscardBackgroundResponse({ ...base, persisted: null }),
    ).toBe(false);
    expect(
      shouldDiscardBackgroundResponse({
        ...base,
        persisted: {
          generatedAt: new Date(requestStartedAt.getTime() - 1_000),
          itemSignature: 'other',
          ...ORIGIN,
        },
      }),
    ).toBe(false);
    expect(
      shouldDiscardBackgroundResponse({
        ...base,
        persisted: {
          generatedAt: NOW,
          itemSignature: 'other',
          latitude: offsetLatitude(2_200),
          longitude: ORIGIN.longitude,
        },
      }),
    ).toBe(true);
    expect(
      shouldDiscardBackgroundResponse({
        ...base,
        persisted: {
          generatedAt: NOW,
          itemSignature: signature,
          ...ORIGIN,
        },
      }),
    ).toBe(true);
    expect(
      shouldDiscardBackgroundResponse({
        ...base,
        persisted: {
          generatedAt: NOW,
          itemSignature: signature,
          latitude: offsetLatitude(2_200),
          longitude: ORIGIN.longitude,
        },
      }),
    ).toBe(false);
  });

  it('keeps a reconciled snapshot when execution expires and never rolls it back', () => {
    expect(
      backgroundDiscoveryCommitPlan({
        expiredOrCancelledBeforeReconcile: true,
        expiredOrCancelledAfterReconcile: false,
      }),
    ).toEqual({ reconcile: false, observe: false, rollBack: false });
    expect(
      backgroundDiscoveryCommitPlan({
        expiredOrCancelledBeforeReconcile: false,
        expiredOrCancelledAfterReconcile: true,
      }),
    ).toEqual({ reconcile: true, observe: false, rollBack: false });
    expect(
      backgroundDiscoveryCommitPlan({
        expiredOrCancelledBeforeReconcile: false,
        expiredOrCancelledAfterReconcile: false,
      }),
    ).toEqual({ reconcile: true, observe: true, rollBack: false });
    expect(
      nextBackgroundSnapshotGeneratedAt(
        new Date('2026-10-23T18:00:00.000Z'),
        new Date('2026-10-23T18:00:00.500Z'),
      ).toISOString(),
    ).toBe('2026-10-23T18:00:00.501Z');
  });

  it('starts an observation only for a newly selected pending store inside the visit accuracy cap', () => {
    const close = {
      placeId: 'close',
      latitude: offsetLatitude(30),
      longitude: ORIGIN.longitude,
      selected: true,
      pending: true,
      newlyScheduled: true,
    };
    const far = {
      ...close,
      placeId: 'far',
      latitude: offsetLatitude(400),
    };
    expect(
      backgroundDiscoveryDistanceMeters(ORIGIN, close),
    ).toBeLessThan(120);
    expect(backgroundDiscoveryDistanceMeters(ORIGIN, far)).toBeGreaterThan(200);
    expect(
      alreadyNearbyStoreIds({
        visitAccuracyMeters: 20,
        visit: ORIGIN,
        stores: [
          close,
          far,
          { ...close, placeId: 'old', newlyScheduled: false },
          { ...close, placeId: 'consumed', pending: false },
          { ...close, placeId: 'unselected', selected: false },
        ],
      }),
    ).toEqual(['close']);
    expect(
      alreadyNearbyStoreIds({
        visitAccuracyMeters: 100.1,
        visit: ORIGIN,
        stores: [close],
      }),
    ).toEqual([]);
    expect(
      alreadyNearbyStoreIds({
        visitAccuracyMeters: -1,
        visit: ORIGIN,
        stores: [close],
      }),
    ).toEqual([]);
    expect(
      alreadyNearbyStoreIds({
        visitAccuracyMeters: 0,
        visit: ORIGIN,
        stores: [{ ...close, latitude: ORIGIN.latitude }],
      }),
    ).toEqual(['close']);
  });

  it('drops an in-flight discovery when saved items change and does not cool down', () => {
    const milkItem = listedItem('milk', 'Milk');
    const breadItem = listedItem('bread', 'Bread');
    const requested = backgroundDiscoveryItemsFromItems([milkItem, breadItem]);
    const requestItemSignature = backgroundDiscoveryItemSignature(requested);

    expect(
      shouldCommitDiscoveredItems({
        requestItemSignature,
        currentItems: backgroundDiscoveryItemsFromItems([breadItem]),
      }),
    ).toBe(false);
    expect(
      shouldCommitDiscoveredItems({
        requestItemSignature,
        currentItems: backgroundDiscoveryItemsFromItems(
          completeItem([milkItem, breadItem], 'milk', '2026-10-23T18:05:00.000Z'),
        ),
      }),
    ).toBe(false);
    expect(
      shouldCommitDiscoveredItems({
        requestItemSignature: backgroundDiscoveryItemSignature([milk]),
        currentItems: [{ ...milk, revision: 2, text: 'Oat milk' }],
      }),
    ).toBe(false);
    expect(
      shouldCommitDiscoveredItems({
        requestItemSignature: backgroundDiscoveryItemSignature([milk]),
        currentItems: [milk],
      }),
    ).toBe(true);
    expect(shouldRecordFailureCooldown('input-changed')).toBe(false);
    expect(shouldRecordFailureCooldown('timeout')).toBe(true);
    expect(
      decideBackgroundDiscovery(
        decisionInput({
          items: [milk],
          attempt: emptyBackgroundDiscoveryAttempt(),
        }),
      ),
    ).toEqual({ action: 'search' });
  });
});

function listedItem(id: string, text: string): Item {
  return {
    id,
    text,
    createdAt: '2026-10-23T17:00:00.000Z',
    updatedAt: '2026-10-23T17:00:00.000Z',
    revision: 1,
    classification: {
      status: 'current',
      sourceRevision: 1,
      sourceText: text,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      result: {
        outcome: 'classified',
        categories: ['grocery-store'],
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      },
    },
  };
}
