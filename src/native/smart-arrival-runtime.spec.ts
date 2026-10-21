import { describe, expect, it } from 'vitest';

import {
  NATIVE_GEOFENCE_RADIUS_METERS,
  NATIVE_MAX_LOCATION_TRIGGERS,
  classifyNativeRequestTransition,
  selectNearestNativeStores,
} from './geofence-native-contract';
import {
  SMART_ARRIVAL_MINIMUM_IOS_MAJOR_VERSION,
  canRegisterAdditionalRegion,
  conservativeOccupiedRegionIdentifiers,
  isSmartArrivalObservationEligible,
  isSmartArrivalRuntimeEligible,
  leftoverManagedLocationTriggerIds,
  missingSmartArrivalObservationRequirements,
  smartArrivalInstallationIsDegraded,
  nextObservationDeadline,
  selectCurrentHistoryActivity,
  shouldFallbackToImmediateGeofenceNotification,
  type SmartArrivalHistoryActivity,
  shouldReconstructObservationRuntime,
  shouldRetainAlwaysServiceSession,
  shouldRunSharedObservationStreams,
  verifyManagedCircularRegion,
} from './smart-arrival-runtime';

const STORE = { latitude: 34.02, longitude: -118.43 };
const STARTED_AT = '2026-10-20T16:01:54.475Z';

function at(millisecondsAfterStart: number): string {
  return new Date(Date.parse(STARTED_AT) + millisecondsAfterStart).toISOString();
}

function region(
  identifier: string,
  overrides: Partial<Parameters<typeof verifyManagedCircularRegion>[0]> = {},
) {
  return {
    identifier,
    latitude: STORE.latitude,
    longitude: STORE.longitude,
    radiusMeters: NATIVE_GEOFENCE_RADIUS_METERS,
    notifyOnEntry: true,
    notifyOnExit: false,
    ...overrides,
  };
}

describe('Smart Arrival runtime eligibility', () => {
  it('requires iOS 18+ circular region monitoring and never falls back', () => {
    expect(
      isSmartArrivalRuntimeEligible({
        iosMajorVersion: SMART_ARRIVAL_MINIMUM_IOS_MAJOR_VERSION,
        regionMonitoringAvailable: true,
      }),
    ).toBe(true);
    expect(
      isSmartArrivalRuntimeEligible({
        iosMajorVersion: 17,
        regionMonitoringAvailable: true,
      }),
    ).toBe(false);
    expect(
      isSmartArrivalRuntimeEligible({
        iosMajorVersion: 18,
        regionMonitoringAvailable: false,
      }),
    ).toBe(false);
    expect(shouldFallbackToImmediateGeofenceNotification()).toBe(false);
  });

  it('reports every missing observation permission without changing region eligibility', () => {
    const eligible = {
      iosMajorVersion: SMART_ARRIVAL_MINIMUM_IOS_MAJOR_VERSION,
      regionMonitoringAvailable: true,
      authorizedAlways: true,
      preciseLocation: true,
      motionAuthorized: true,
      notificationsAuthorized: true,
    };
    expect(missingSmartArrivalObservationRequirements(eligible)).toEqual([]);
    expect(isSmartArrivalObservationEligible(eligible)).toBe(true);
    expect(
      missingSmartArrivalObservationRequirements({
        ...eligible,
        iosMajorVersion: 17,
        regionMonitoringAvailable: false,
        authorizedAlways: false,
        preciseLocation: false,
        motionAuthorized: false,
        notificationsAuthorized: false,
      }),
    ).toEqual([
      'ios-version',
      'region-monitoring',
      'always-location',
      'precise-location',
      'motion',
      'notifications',
    ]);
    expect(
      isSmartArrivalRuntimeEligible({
        iosMajorVersion: 18,
        regionMonitoringAvailable: true,
      }),
    ).toBe(true);
    expect(
      smartArrivalInstallationIsDegraded({
        selectedIsDegraded: false,
        hasPendingCancellations: false,
        hasDeliveryIntents: false,
        hasInstalledManagedRegion: true,
        observationEligible: false,
      }),
    ).toBe(true);
    expect(
      smartArrivalInstallationIsDegraded({
        selectedIsDegraded: false,
        hasPendingCancellations: false,
        hasDeliveryIntents: true,
        hasInstalledManagedRegion: false,
        observationEligible: true,
      }),
    ).toBe(true);
    expect(
      smartArrivalInstallationIsDegraded({
        selectedIsDegraded: false,
        hasPendingCancellations: false,
        hasDeliveryIntents: false,
        hasInstalledManagedRegion: false,
        observationEligible: false,
      }),
    ).toBe(false);
  });
});

describe('Smart Arrival region registration', () => {
  it('re-registers a missing matching region instead of consuming it', () => {
    const [desired] = selectNearestNativeStores({
      schemaVersion: 1,
      generatedAt: STARTED_AT,
      discoveryAnchor: STORE,
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
          placeId: 'whole-foods',
          name: 'Whole Foods',
          location: STORE,
          itemIds: ['item-milk'],
        },
      ],
    });

    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: false,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('add');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'pending',
          isPending: true,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('unchanged');
    expect(
      classifyNativeRequestTransition({
        desired,
        existing: {
          status: 'consumed',
          isPending: false,
          fingerprintInput: desired.fingerprintInput,
          itemReferences: desired.itemReferences,
        },
      }),
    ).toBe('consumed-same-fingerprint');
  });

  it('verifies production regions and counts the conservative 20-slot union', () => {
    const installationId = 'tyg.arrival.v1.store-a';
    expect(
      verifyManagedCircularRegion(region(installationId), {
        identifier: installationId,
        latitude: STORE.latitude,
        longitude: STORE.longitude,
      }),
    ).toBe(true);
    expect(
      verifyManagedCircularRegion(
        region(installationId, { radiusMeters: 75, notifyOnExit: true }),
        {
          identifier: installationId,
          latitude: STORE.latitude,
          longitude: STORE.longitude,
        },
      ),
    ).toBe(false);

    const occupied = conservativeOccupiedRegionIdentifiers(
      [
        'tyg.arrival.v1.old-trigger',
        'unrelated.location.trigger',
        installationId,
      ],
      [
        installationId,
        'tyg.diagnostic.arrival.v1.trader-joes-119',
        'unrelated.region',
      ],
    );
    expect(occupied).toEqual([
      'tyg.arrival.v1.old-trigger',
      installationId,
      'tyg.diagnostic.arrival.v1.trader-joes-119',
      'unrelated.location.trigger',
      'unrelated.region',
    ]);
    expect(
      leftoverManagedLocationTriggerIds([
        'tyg.arrival.v1.old-trigger',
        'unrelated.location.trigger',
        'tyg.diagnostic.arrival.v1.trader-joes-119',
      ]),
    ).toEqual(['tyg.arrival.v1.old-trigger']);
    expect(
      canRegisterAdditionalRegion({
        occupiedIdentifiers: occupied,
        reusableIdentifier: installationId,
      }),
    ).toBe(true);

    const full = Array.from(
      { length: NATIVE_MAX_LOCATION_TRIGGERS },
      (_, index) => `occupied-${index}`,
    );
    expect(canRegisterAdditionalRegion({ occupiedIdentifiers: full })).toBe(
      false,
    );
    expect(
      canRegisterAdditionalRegion({
        occupiedIdentifiers: full,
        reusableIdentifier: 'occupied-0',
      }),
    ).toBe(true);
  });
});

describe('Smart Arrival observation runtime', () => {
  it('shares one stream across overlapping observations and reconstructs live ones', () => {
    expect(shouldRunSharedObservationStreams(0)).toBe(false);
    expect(shouldRunSharedObservationStreams(1)).toBe(true);
    expect(shouldRunSharedObservationStreams(2)).toBe(true);

    expect(
      shouldRetainAlwaysServiceSession({
        pendingMonitoredRegionCount: 2,
        activeObservationCount: 0,
        authorizedAlways: true,
        preciseLocation: true,
      }),
    ).toBe(true);
    expect(
      shouldRetainAlwaysServiceSession({
        pendingMonitoredRegionCount: 0,
        activeObservationCount: 0,
        authorizedAlways: true,
        preciseLocation: true,
      }),
    ).toBe(false);
    expect(
      shouldRetainAlwaysServiceSession({
        pendingMonitoredRegionCount: 2,
        activeObservationCount: 1,
        authorizedAlways: false,
        preciseLocation: true,
      }),
    ).toBe(false);

    const active = [
      { identifier: 'obs-b', deadline: at(240_000) },
      { identifier: 'obs-a', deadline: at(90_000) },
    ];
    expect(nextObservationDeadline(active, at(1_000))).toBe(at(90_000));
    expect(nextObservationDeadline(active, at(90_000))).toBe(at(240_000));
    expect(nextObservationDeadline(active, at(240_000))).toBeNull();
    expect(
      shouldReconstructObservationRuntime({
        eligible: true,
        observations: active,
        now: at(1_000),
      }),
    ).toBe(true);
    expect(
      shouldReconstructObservationRuntime({
        eligible: true,
        observations: active,
        now: at(240_000),
      }),
    ).toBe(false);
    expect(
      shouldReconstructObservationRuntime({
        eligible: false,
        observations: active,
        now: at(1_000),
      }),
    ).toBe(false);
  });
});

describe('Smart Arrival current history activity', () => {
  const observation = {
    observationStartedAt: STARTED_AT,
    observationDeadline: at(240_000),
  };
  const walk = {
    activityStartedAt: at(-60_000),
    automotive: false,
    walking: true,
    confidence: 'high' as const,
  };
  const driving = {
    activityStartedAt: at(20_000),
    automotive: true,
    walking: false,
    confidence: 'high' as const,
  };

  function succeeded(
    activities: readonly SmartArrivalHistoryActivity[],
    overrides: { from?: string; to?: string } = {},
  ) {
    return selectCurrentHistoryActivity({
      query: {
        status: 'success',
        from: overrides.from ?? at(-120_000),
        to: overrides.to ?? at(30_000),
        activities,
      },
      ...observation,
    });
  }

  it('returns nothing when the query fails, is empty, or misses the observation', () => {
    expect(
      selectCurrentHistoryActivity({
        query: { status: 'failed' },
        ...observation,
      }),
    ).toBeNull();
    expect(
      selectCurrentHistoryActivity({
        query: { status: 'empty' },
        ...observation,
      }),
    ).toBeNull();
    expect(succeeded([walk], { to: at(-1) })).toBeNull();
    expect(succeeded([walk], { to: at(240_000) })).toBeNull();
    expect(succeeded([walk], { from: at(40_000), to: at(30_000) })).toBeNull();
    expect(
      succeeded([
        {
          ...walk,
          activityStartedAt: at(31_000),
        },
      ]),
    ).toBeNull();
  });

  it('uses the activity in effect at the query endpoint', () => {
    expect(succeeded([walk])).toEqual(walk);
    expect(
      succeeded([
        {
          ...walk,
          activityStartedAt: at(-180_000),
        },
      ]),
    ).toMatchObject({ walking: true, automotive: false });
    expect(succeeded([driving, walk])).toEqual(driving);
    expect(
      succeeded([
        walk,
        {
          ...walk,
          activityStartedAt: at(31_000),
          confidence: 'medium',
        },
      ]),
    ).toEqual(walk);
  });
});
