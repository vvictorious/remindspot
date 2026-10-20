import { describe, expect, it } from 'vitest';

import {
  ARRIVAL_DIAGNOSTIC_ACTIVITY_EVENT_TYPE,
  ARRIVAL_DIAGNOSTIC_ACTIVITY_LABELS,
  ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_DISTANCE_INCREASE_METERS,
  ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_EVENT_TYPE,
  ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MAXIMUM_HORIZONTAL_ACCURACY_METERS,
  ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MAXIMUM_SPEED_ACCURACY_METERS_PER_SECOND,
  ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MINIMUM_DISTANCE_METERS,
  ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MINIMUM_SPEED_METERS_PER_SECOND,
  ARRIVAL_DIAGNOSTIC_HISTORY_QUERY_MAX_SECONDS,
  ARRIVAL_DIAGNOSTIC_LATITUDE,
  ARRIVAL_DIAGNOSTIC_LONGITUDE,
  ARRIVAL_DIAGNOSTIC_MAX_HISTORICAL_ACTIVITIES,
  ARRIVAL_DIAGNOSTIC_MOTION_LOOKBACK_SECONDS,
  ARRIVAL_DIAGNOSTIC_OBSERVATION_SECONDS,
  ARRIVAL_DIAGNOSTIC_RADIUS_METERS,
  ARRIVAL_DIAGNOSTIC_WOULD_NOTIFY_EVENT_TYPE,
  ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER,
  ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER_PREFIX,
  ARRIVAL_DIAGNOSTIC_STORE_ADDRESS,
  ARRIVAL_DIAGNOSTIC_STORE_IDENTIFIER,
  ARRIVAL_DIAGNOSTIC_STORE_NAME,
  ArrivalDiagnosticHistoryWindowError,
  assessArrivalDiagnosticCapacity,
  closestAccurateDistanceMeters,
  describeArrivalDiagnosticActivity,
  describeDriveAwayWouldEnd,
  describeSmartArrivalWouldNotify,
  diagnosticContractIsIsolated,
  diagnosticMonitoredRadiusMatches,
  hasArrivalDiagnosticDeadlineExpired,
  hasQualifyingDriveAwayAutomotiveEvidence,
  observationWasReconstructed,
  parseArrivalDiagnosticHistoryWindow,
  resolveObservationDeadlineMilliseconds,
  selectFirstDriveAwayLocation,
  selectLatestFreshLocationSample,
  selectPriorAutomotiveEvidence,
  shouldRecordDriveAwayWouldEnd,
  shouldRecordSmartArrivalWouldNotify,
  smartArrivalDecisionElapsedSeconds,
  type ArrivalDiagnosticLocationSample,
} from './arrival-diagnostic-contract';

describe('arrival diagnostic contract', () => {
  it("uses one distinct 75-meter Trader Joe's region and a 240-second observation", () => {
    expect(ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER).toBe(
      'tyg.diagnostic.arrival.v1.trader-joes-119',
    );
    expect(ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER).toMatch(
      new RegExp(`^${ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER_PREFIX}`),
    );
    expect(ARRIVAL_DIAGNOSTIC_STORE_IDENTIFIER).toBe('trader-joes-119');
    expect(ARRIVAL_DIAGNOSTIC_STORE_NAME).toBe("Trader Joe's");
    expect(ARRIVAL_DIAGNOSTIC_STORE_ADDRESS).toBe(
      '3456 S Sepulveda Blvd, Los Angeles, CA 90034',
    );
    expect(ARRIVAL_DIAGNOSTIC_LATITUDE).toBe(34.0203234);
    expect(ARRIVAL_DIAGNOSTIC_LONGITUDE).toBe(-118.422068);
    expect(ARRIVAL_DIAGNOSTIC_RADIUS_METERS).toBe(75);
    expect(ARRIVAL_DIAGNOSTIC_WOULD_NOTIFY_EVENT_TYPE).toBe(
      'smart-arrival-would-notify',
    );
    expect(ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_EVENT_TYPE).toBe(
      'drive-away-would-end',
    );
    expect(ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MINIMUM_DISTANCE_METERS).toBe(125);
    expect(ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_DISTANCE_INCREASE_METERS).toBe(50);
    expect(ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MINIMUM_SPEED_METERS_PER_SECOND).toBe(
      4,
    );
    expect(
      ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MAXIMUM_HORIZONTAL_ACCURACY_METERS,
    ).toBe(15);
    expect(
      ARRIVAL_DIAGNOSTIC_DRIVE_AWAY_MAXIMUM_SPEED_ACCURACY_METERS_PER_SECOND,
    ).toBe(1);
    expect(diagnosticMonitoredRadiusMatches(75)).toBe(true);
    expect(diagnosticMonitoredRadiusMatches(75.009)).toBe(true);
    expect(diagnosticMonitoredRadiusMatches(100)).toBe(false);
    expect(ARRIVAL_DIAGNOSTIC_OBSERVATION_SECONDS).toBe(240);
    expect(diagnosticContractIsIsolated()).toBe(true);
  });

  it('treats an equal or passed deadline as expired', () => {
    const deadline = Date.parse('2026-10-19T21:00:00.000Z');

    expect(hasArrivalDiagnosticDeadlineExpired(deadline - 1, deadline)).toBe(
      false,
    );
    expect(hasArrivalDiagnosticDeadlineExpired(deadline, deadline)).toBe(true);
    expect(hasArrivalDiagnosticDeadlineExpired(deadline + 1, deadline)).toBe(
      true,
    );
  });

  it('records activity labels without classifying arrival', () => {
    expect(ARRIVAL_DIAGNOSTIC_ACTIVITY_LABELS).toEqual([
      'automotive',
      'stationary',
      'walking',
      'running',
      'unknown',
    ]);
    expect(ARRIVAL_DIAGNOSTIC_ACTIVITY_EVENT_TYPE).toBe(
      'activity-classification',
    );
    expect(ARRIVAL_DIAGNOSTIC_MOTION_LOOKBACK_SECONDS).toBe(120);
    expect(ARRIVAL_DIAGNOSTIC_MAX_HISTORICAL_ACTIVITIES).toBe(16);
    expect(
      describeArrivalDiagnosticActivity({
        source: 'historical-query',
        automotive: true,
        stationary: false,
        walking: false,
        running: false,
        unknown: false,
        confidence: 'high',
      }),
    ).toEqual({
      labels: ['automotive'],
      detail: 'historical-query:automotive:high',
    });
    expect(
      describeArrivalDiagnosticActivity({
        source: 'live',
        automotive: false,
        stationary: true,
        walking: true,
        running: false,
        unknown: false,
        cycling: true,
        confidence: 'medium',
      }).detail,
    ).toBe('live:stationary,walking+cycling:medium');
  });

  it('conservatively unions notification and programmable region occupancy', () => {
    const result = assessArrivalDiagnosticCapacity({
      pendingLocationNotificationIds: Array.from(
        { length: 15 },
        (_, index) => `tyg.arrival.v1.${index}`,
      ),
      monitoredRegionIds: ['unrelated-programmable-region'],
    });

    expect(result).toEqual({
      conservativeOccupiedRegionCount: 16,
      occupiedAfterArm: 17,
      canArm: true,
    });
  });

  it('refuses to consume a twenty-first slot and permits an existing diagnostic', () => {
    const occupiedIds = Array.from(
      { length: 20 },
      (_, index) => `occupied-${index}`,
    );

    expect(
      assessArrivalDiagnosticCapacity({
        pendingLocationNotificationIds: occupiedIds,
        monitoredRegionIds: [],
      }).canArm,
    ).toBe(false);

    expect(
      assessArrivalDiagnosticCapacity({
        pendingLocationNotificationIds: occupiedIds.slice(0, 19),
        monitoredRegionIds: [ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER],
      }),
    ).toMatchObject({
      conservativeOccupiedRegionCount: 20,
      occupiedAfterArm: 20,
      canArm: true,
    });
  });

  it('treats a prior diagnostic identifier as the reusable slot', () => {
    expect(
      assessArrivalDiagnosticCapacity({
        pendingLocationNotificationIds: Array.from(
          { length: 19 },
          (_, index) => `occupied-${index}`,
        ),
        monitoredRegionIds: ['tyg.diagnostic.arrival.v1.ups-4398'],
      }),
    ).toMatchObject({
      conservativeOccupiedRegionCount: 20,
      occupiedAfterArm: 20,
      canArm: true,
    });
  });
});

describe('smart arrival would-notify', () => {
  const observationStartedAt = Date.parse('2026-10-19T22:05:32.000Z');
  const walkingStartedAt = Date.parse('2026-10-19T22:06:24.600Z');
  const decisionAt = Date.parse('2026-10-19T22:06:25.100Z');

  it('qualifies the first high-confidence walk at or after entry without automotive history', () => {
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'live',
        walking: true,
        automotive: false,
        confidence: 'high',
        activityStartedAtMilliseconds: walkingStartedAt,
      }),
    ).toBe(true);
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'historical-query',
        walking: true,
        automotive: false,
        confidence: 'high',
        activityStartedAtMilliseconds: observationStartedAt,
      }),
    ).toBe(true);
  });

  it('rejects a walk that started before entry, a low-confidence sample, and a second decision', () => {
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'live',
        walking: true,
        automotive: false,
        confidence: 'high',
        activityStartedAtMilliseconds: observationStartedAt - 1,
      }),
    ).toBe(false);
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'live',
        walking: true,
        automotive: true,
        confidence: 'high',
        activityStartedAtMilliseconds: walkingStartedAt,
      }),
    ).toBe(false);
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'live',
        walking: true,
        automotive: false,
        confidence: 'medium',
        activityStartedAtMilliseconds: walkingStartedAt,
      }),
    ).toBe(false);
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'authorization-prompt',
        walking: true,
        automotive: false,
        confidence: 'high',
        activityStartedAtMilliseconds: walkingStartedAt,
      }),
    ).toBe(false);
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: true,
        source: 'live',
        walking: true,
        automotive: false,
        confidence: 'high',
        activityStartedAtMilliseconds: walkingStartedAt,
      }),
    ).toBe(false);
  });

  it('measures the decision from evidence time and keeps the walking start separate', () => {
    expect(
      smartArrivalDecisionElapsedSeconds(observationStartedAt, decisionAt),
    ).toBeCloseTo(53.1, 3);
    expect(
      smartArrivalDecisionElapsedSeconds(observationStartedAt, walkingStartedAt),
    ).toBeCloseTo(52.6, 3);

    const prior = selectPriorAutomotiveEvidence(
      [
        {
          source: 'historical-query' as const,
          automotive: true,
          confidence: 'high' as const,
          activityStartedAtMilliseconds: observationStartedAt - 20_000,
        },
        {
          source: 'live' as const,
          automotive: true,
          confidence: 'high' as const,
          activityStartedAtMilliseconds: observationStartedAt + 1_000,
        },
        {
          source: 'live' as const,
          automotive: false,
          confidence: 'high' as const,
          activityStartedAtMilliseconds: walkingStartedAt,
        },
      ],
      walkingStartedAt,
    );

    expect(prior?.activityStartedAtMilliseconds).toBe(observationStartedAt + 1_000);
    expect(
      describeSmartArrivalWouldNotify({
        walkingStartedAt: '2026-10-19T22:06:24.600Z',
        decisionAt: '2026-10-19T22:06:25.100Z',
        elapsedSeconds: smartArrivalDecisionElapsedSeconds(
          observationStartedAt,
          decisionAt,
        ),
        priorAutomotive: {
          activityStartedAt: '2026-10-19T22:05:33.000Z',
          confidence: 'high',
          source: 'live',
        },
      }),
    ).toBe(
      'radiusMeters=75;walkingStartedAt=2026-10-19T22:06:24.600Z;decisionAt=2026-10-19T22:06:25.100Z;elapsedSeconds=53.100;priorAutomotiveStart=2026-10-19T22:05:33.000Z;priorAutomotiveConfidence=high;priorAutomotiveSource=live',
    );
    expect(
      describeSmartArrivalWouldNotify({
        walkingStartedAt: '2026-10-19T22:06:24.600Z',
        decisionAt: '2026-10-19T22:06:25.100Z',
        elapsedSeconds: 53.1,
        priorAutomotive: null,
      }),
    ).toContain('priorAutomotive=none');
  });

  it('keeps an in-progress deadline and records decision-time context separately from walking start', () => {
    const startedAt = Date.parse('2026-10-20T01:26:35.765Z');
    const persistedDeadline = startedAt + 90_000;

    expect(
      resolveObservationDeadlineMilliseconds({
        startedAtMilliseconds: startedAt,
        persistedDeadlineMilliseconds: persistedDeadline,
      }),
    ).toBe(persistedDeadline);
    expect(
      resolveObservationDeadlineMilliseconds({
        startedAtMilliseconds: startedAt,
      }),
    ).toBe(startedAt + ARRIVAL_DIAGNOSTIC_OBSERVATION_SECONDS * 1000);
    expect(observationWasReconstructed(['region-enter-callback'])).toBe(false);
    expect(
      observationWasReconstructed([
        'live-observation-reconstructed',
        'live-location-update',
      ]),
    ).toBe(true);
    expect(
      selectLatestFreshLocationSample([
        { fresh: true, distanceMeters: 40 },
        { fresh: false, distanceMeters: 120 },
        { fresh: true, distanceMeters: 18.4 },
      ]),
    ).toEqual({ fresh: true, distanceMeters: 18.4 });
    expect(
      describeSmartArrivalWouldNotify({
        walkingStartedAt: '2026-10-20T01:27:53.608Z',
        decisionAt: '2026-10-20T01:27:53.658Z',
        elapsedSeconds: 77.893,
        priorAutomotive: {
          activityStartedAt: '2026-10-20T01:27:01.745Z',
          confidence: 'high',
          source: 'live',
        },
        locationSample: {
          distanceMeters: 18.4,
          speedMetersPerSecond: 1.2,
          horizontalAccuracyMeters: 4.1,
          sampleAgeSeconds: 0.037,
        },
        remainingDeadlineSeconds: 12.107,
        backgroundTaskActive: false,
        observationReconstructed: true,
      }),
    ).toBe(
      'radiusMeters=75;walkingStartedAt=2026-10-20T01:27:53.608Z;decisionAt=2026-10-20T01:27:53.658Z;elapsedSeconds=77.893;priorAutomotiveStart=2026-10-20T01:27:01.745Z;priorAutomotiveConfidence=high;priorAutomotiveSource=live;distanceMeters=18.400;speedMetersPerSecond=1.200;horizontalAccuracyMeters=4.100;sampleAgeSeconds=0.037;remainingDeadlineSeconds=12.107;backgroundTaskActive=false;observationReconstructed=true',
    );
    expect(
      describeSmartArrivalWouldNotify({
        walkingStartedAt: '2026-10-20T01:27:53.608Z',
        decisionAt: '2026-10-20T01:27:53.658Z',
        elapsedSeconds: 77.893,
        locationSample: null,
        remainingDeadlineSeconds: 12.107,
        backgroundTaskActive: true,
        observationReconstructed: false,
      }),
    ).toContain('locationSample=none;remainingDeadlineSeconds=12.107');
  });
});

describe('drive-away would-end', () => {
  const observationStartedAt = Date.parse('2026-10-20T01:26:35.765Z');

  function location(
    sequence: number,
    overrides: Partial<ArrivalDiagnosticLocationSample> = {},
  ): ArrivalDiagnosticLocationSample {
    return {
      sequence,
      fresh: true,
      horizontalAccuracyMeters: 4,
      speedMetersPerSecond: 5,
      speedAccuracyMetersPerSecond: 0.4,
      distanceFromStoreMeters: 140,
      ...overrides,
    };
  }

  it('records the first conservative departure and ignores a later duplicate', () => {
    const samples = [
      location(1, {
        distanceFromStoreMeters: 10,
        horizontalAccuracyMeters: 39.8,
        speedMetersPerSecond: null,
        speedAccuracyMetersPerSecond: null,
      }),
      location(2, {
        distanceFromStoreMeters: 55.2,
        speedMetersPerSecond: 3.97,
        speedAccuracyMetersPerSecond: 0.48,
      }),
      location(3, { distanceFromStoreMeters: 60 }),
      location(4, { distanceFromStoreMeters: 130, speedMetersPerSecond: 4 }),
      location(5, { distanceFromStoreMeters: 180, speedMetersPerSecond: 8 }),
    ];
    const automotive = hasQualifyingDriveAwayAutomotiveEvidence({
      observationStartedAtMilliseconds: observationStartedAt,
      samples: [
        {
          source: 'live',
          automotive: true,
          walking: false,
          confidence: 'high',
          activityStartedAtMilliseconds: observationStartedAt + 1_000,
        },
      ],
    });

    expect(closestAccurateDistanceMeters(samples, 4)).toBe(55.2);
    expect(selectFirstDriveAwayLocation(samples, automotive)).toEqual({
      sample: samples[3],
      closestAccurateDistanceMeters: 55.2,
    });
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: true,
        automotiveHighConfidenceAfterEntry: true,
        sample: samples[4]!,
        closestAccurateDistanceMeters: 55.2,
      }),
    ).toBe(false);
    expect(
      describeDriveAwayWouldEnd({
        distanceMeters: 130,
        closestDistanceMeters: 55.2,
        speedMetersPerSecond: 4,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.4,
        sampleAgeSeconds: 0.04,
        elapsedSeconds: 40,
        automotiveStartedAt: '2026-10-20T01:26:36.765Z',
      }),
    ).toBe(
      'distanceMeters=130.000;closestDistanceMeters=55.200;distanceIncreaseMeters=74.800;speedMetersPerSecond=4.000;horizontalAccuracyMeters=4.000;speedAccuracyMetersPerSecond=0.400;sampleAgeSeconds=0.040;elapsedSeconds=40.000;automotiveStartedAt=2026-10-20T01:26:36.765Z',
    );
  });

  it('rejects jitter, in-lot speed, missing automotive evidence, and a baseline that is not accurate', () => {
    const accurateBaseline = location(1, { distanceFromStoreMeters: 60 });
    const looseStartup = location(1, {
      distanceFromStoreMeters: 10,
      horizontalAccuracyMeters: 39.8,
      speedMetersPerSecond: null,
      speedAccuracyMetersPerSecond: null,
    });
    const departing = location(2, {
      distanceFromStoreMeters: 130,
      speedMetersPerSecond: 4,
      horizontalAccuracyMeters: 15,
      speedAccuracyMetersPerSecond: 1,
    });

    expect(closestAccurateDistanceMeters([looseStartup, departing], 2)).toBe(
      null,
    );
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: true,
        sample: departing,
        closestAccurateDistanceMeters: null,
      }),
    ).toBe(false);
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: true,
        sample: location(2, {
          distanceFromStoreMeters: 55.2,
          speedMetersPerSecond: 3.97,
        }),
        closestAccurateDistanceMeters: 20,
      }),
    ).toBe(false);
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: true,
        sample: location(2, {
          distanceFromStoreMeters: 109.9,
          speedMetersPerSecond: 4,
        }),
        closestAccurateDistanceMeters: 60,
      }),
    ).toBe(false);
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: true,
        sample: location(2, { speedAccuracyMetersPerSecond: 1.5 }),
        closestAccurateDistanceMeters: 60,
      }),
    ).toBe(false);
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: true,
        sample: location(2, { fresh: false }),
        closestAccurateDistanceMeters: 60,
      }),
    ).toBe(false);
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: false,
        sample: departing,
        closestAccurateDistanceMeters: 60,
      }),
    ).toBe(false);
    expect(
      hasQualifyingDriveAwayAutomotiveEvidence({
        observationStartedAtMilliseconds: observationStartedAt,
        samples: [
          {
            source: 'live',
            automotive: true,
            walking: true,
            confidence: 'high',
            activityStartedAtMilliseconds: observationStartedAt + 1_000,
          },
          {
            source: 'historical-query',
            automotive: true,
            walking: false,
            confidence: 'high',
            activityStartedAtMilliseconds: observationStartedAt - 1,
          },
          {
            source: 'authorization-prompt',
            automotive: true,
            walking: false,
            confidence: 'high',
            activityStartedAtMilliseconds: observationStartedAt + 1_000,
          },
          {
            source: 'live',
            automotive: true,
            walking: false,
            confidence: 'medium',
            activityStartedAtMilliseconds: observationStartedAt + 1_000,
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldRecordDriveAwayWouldEnd({
        alreadyRecorded: false,
        automotiveHighConfidenceAfterEntry: true,
        sample: departing,
        closestAccurateDistanceMeters:
          accurateBaseline.distanceFromStoreMeters,
      }),
    ).toBe(true);
    expect(
      shouldRecordSmartArrivalWouldNotify({
        observationStartedAtMilliseconds: observationStartedAt,
        alreadyDecided: false,
        source: 'live',
        walking: true,
        automotive: false,
        confidence: 'high',
        activityStartedAtMilliseconds: observationStartedAt + 77_000,
      }),
    ).toBe(true);
  });
});

describe('historical activity query window', () => {
  it('accepts the Shell visit window and a whole-second timestamp', () => {
    expect(ARRIVAL_DIAGNOSTIC_HISTORY_QUERY_MAX_SECONDS).toBe(1800);
    expect(
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:41:23.120Z',
        '2026-10-16T20:49:00.446Z',
      ),
    ).toEqual({
      from: '2026-10-16T20:41:23.120Z',
      to: '2026-10-16T20:49:00.446Z',
    });
    expect(
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:39:23Z',
        '2026-10-16T20:52:00.000Z',
      ),
    ).toEqual({
      from: '2026-10-16T20:39:23.000Z',
      to: '2026-10-16T20:52:00.000Z',
    });
  });

  it('accepts exactly 30 minutes and rejects a longer window', () => {
    expect(
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:41:23.120Z',
        '2026-10-16T21:11:23.120Z',
      ).to,
    ).toBe('2026-10-16T21:11:23.120Z');

    expect(() =>
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:41:23.120Z',
        '2026-10-16T21:11:23.121Z',
      ),
    ).toThrow(ArrivalDiagnosticHistoryWindowError);
    expect(() =>
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:41:23.120Z',
        '2026-10-16T21:11:23.121Z',
      ),
    ).toThrow('History queries are limited to 30 minutes.');
  });

  it('rejects inverted, invalid, and non-UTC timestamps', () => {
    expect(() =>
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:49:00.446Z',
        '2026-10-16T20:41:23.120Z',
      ),
    ).toThrow('History query start must be before its end.');
    expect(() =>
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T20:41:23.120Z',
        '2026-10-16T20:41:23.120Z',
      ),
    ).toThrow('History query start must be before its end.');
    expect(() =>
      parseArrivalDiagnosticHistoryWindow(
        '2026-02-31T00:00:00.000Z',
        '2026-02-31T00:10:00.000Z',
      ),
    ).toThrow(
      'History query timestamps must be UTC ISO-8601, such as 2026-10-16T20:41:23.120Z.',
    );
    expect(() =>
      parseArrivalDiagnosticHistoryWindow(
        '2026-10-16T13:41:23.120-07:00',
        '2026-10-16T13:49:00.446-07:00',
      ),
    ).toThrow(ArrivalDiagnosticHistoryWindowError);
  });
});
