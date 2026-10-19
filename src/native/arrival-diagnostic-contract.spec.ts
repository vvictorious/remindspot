import { describe, expect, it } from 'vitest';

import {
  ARRIVAL_DIAGNOSTIC_ACTIVITY_EVENT_TYPE,
  ARRIVAL_DIAGNOSTIC_ACTIVITY_LABELS,
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
  describeArrivalDiagnosticActivity,
  describeSmartArrivalWouldNotify,
  diagnosticContractIsIsolated,
  diagnosticMonitoredRadiusMatches,
  hasArrivalDiagnosticDeadlineExpired,
  parseArrivalDiagnosticHistoryWindow,
  selectPriorAutomotiveEvidence,
  shouldRecordSmartArrivalWouldNotify,
  smartArrivalDecisionElapsedSeconds,
} from './arrival-diagnostic-contract';

describe('arrival diagnostic contract', () => {
  it("uses one distinct 75-meter Trader Joe's region and a 90-second observation", () => {
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
    expect(diagnosticMonitoredRadiusMatches(75)).toBe(true);
    expect(diagnosticMonitoredRadiusMatches(75.009)).toBe(true);
    expect(diagnosticMonitoredRadiusMatches(100)).toBe(false);
    expect(ARRIVAL_DIAGNOSTIC_OBSERVATION_SECONDS).toBe(90);
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
