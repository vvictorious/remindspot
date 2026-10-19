import {
  NATIVE_MANAGED_IDENTIFIER_PREFIX,
  NATIVE_MAX_LOCATION_TRIGGERS,
  NATIVE_MAX_MONITORED_STORES,
} from './geofence-native-contract';

export const ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER =
  'tyg.diagnostic.arrival.v1.trader-joes-119';
export const ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER_PREFIX =
  'tyg.diagnostic.arrival.v1.';
export const ARRIVAL_DIAGNOSTIC_STORE_IDENTIFIER = 'trader-joes-119';
export const ARRIVAL_DIAGNOSTIC_STORE_NAME = "Trader Joe's";
export const ARRIVAL_DIAGNOSTIC_STORE_ADDRESS =
  '3456 S Sepulveda Blvd, Los Angeles, CA 90034';
export const ARRIVAL_DIAGNOSTIC_LATITUDE = 34.0203234;
export const ARRIVAL_DIAGNOSTIC_LONGITUDE = -118.422068;
export const ARRIVAL_DIAGNOSTIC_RADIUS_METERS = 75;
export const ARRIVAL_DIAGNOSTIC_RADIUS_TOLERANCE_METERS = 0.01;
export const ARRIVAL_DIAGNOSTIC_OBSERVATION_SECONDS = 90;
export const ARRIVAL_DIAGNOSTIC_WOULD_NOTIFY_EVENT_TYPE =
  'smart-arrival-would-notify';
export const ARRIVAL_DIAGNOSTIC_MOTION_LOOKBACK_SECONDS = 120;
export const ARRIVAL_DIAGNOSTIC_MAX_HISTORICAL_ACTIVITIES = 16;
export const ARRIVAL_DIAGNOSTIC_HISTORY_QUERY_MAX_SECONDS = 30 * 60;
export const ARRIVAL_DIAGNOSTIC_ACTIVITY_EVENT_TYPE = 'activity-classification';
export const ARRIVAL_DIAGNOSTIC_ACTIVITY_LABELS = [
  'automotive',
  'stationary',
  'walking',
  'running',
  'unknown',
] as const;

export type ArrivalDiagnosticActivityLabel =
  (typeof ARRIVAL_DIAGNOSTIC_ACTIVITY_LABELS)[number];
export type ArrivalDiagnosticActivitySource =
  | 'live'
  | 'historical-query'
  | 'authorization-prompt';
export type ArrivalDiagnosticActivityConfidence = 'low' | 'medium' | 'high';

export function hasArrivalDiagnosticDeadlineExpired(
  nowMilliseconds: number,
  deadlineMilliseconds: number,
): boolean {
  return nowMilliseconds >= deadlineMilliseconds;
}

export function assessArrivalDiagnosticCapacity(input: {
  pendingLocationNotificationIds: readonly string[];
  monitoredRegionIds: readonly string[];
}): {
  conservativeOccupiedRegionCount: number;
  occupiedAfterArm: number;
  canArm: boolean;
} {
  const identifiers = new Set([
    ...input.pendingLocationNotificationIds,
    ...input.monitoredRegionIds,
  ]);
  const hasReplaceableDiagnostic = [...identifiers].some((identifier) =>
    identifier.startsWith(ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER_PREFIX),
  );
  const occupiedAfterArm = identifiers.size + (hasReplaceableDiagnostic ? 0 : 1);

  return {
    conservativeOccupiedRegionCount: identifiers.size,
    occupiedAfterArm,
    canArm: occupiedAfterArm <= NATIVE_MAX_LOCATION_TRIGGERS,
  };
}

export function describeArrivalDiagnosticActivity(input: {
  source: ArrivalDiagnosticActivitySource;
  automotive: boolean;
  stationary: boolean;
  walking: boolean;
  running: boolean;
  unknown: boolean;
  cycling?: boolean;
  confidence: ArrivalDiagnosticActivityConfidence;
}): {
  labels: ArrivalDiagnosticActivityLabel[];
  detail: string;
} {
  const labels = ARRIVAL_DIAGNOSTIC_ACTIVITY_LABELS.filter(
    (label) => input[label],
  );
  const cyclingSuffix = input.cycling ? '+cycling' : '';

  return {
    labels,
    detail: `${input.source}:${labels.join(',') || 'none'}${cyclingSuffix}:${input.confidence}`,
  };
}

export function diagnosticMonitoredRadiusMatches(
  monitoredRadiusMeters: number,
  requestedRadiusMeters = ARRIVAL_DIAGNOSTIC_RADIUS_METERS,
): boolean {
  return (
    Math.abs(monitoredRadiusMeters - requestedRadiusMeters) <
    ARRIVAL_DIAGNOSTIC_RADIUS_TOLERANCE_METERS
  );
}

export function shouldRecordSmartArrivalWouldNotify(input: {
  observationStartedAtMilliseconds: number;
  alreadyDecided: boolean;
  source: ArrivalDiagnosticActivitySource;
  walking: boolean;
  automotive: boolean;
  confidence: ArrivalDiagnosticActivityConfidence;
  activityStartedAtMilliseconds: number;
}): boolean {
  return (
    !input.alreadyDecided &&
    (input.source === 'live' || input.source === 'historical-query') &&
    input.walking &&
    !input.automotive &&
    input.confidence === 'high' &&
    input.activityStartedAtMilliseconds >= input.observationStartedAtMilliseconds
  );
}

export function smartArrivalDecisionElapsedSeconds(
  observationStartedAtMilliseconds: number,
  decisionAtMilliseconds: number,
): number {
  return Math.max(
    0,
    (decisionAtMilliseconds - observationStartedAtMilliseconds) / 1000,
  );
}

export function selectPriorAutomotiveEvidence<
  T extends {
    automotive: boolean;
    activityStartedAtMilliseconds: number;
  },
>(samples: readonly T[], walkingStartedAtMilliseconds: number): T | null {
  let selected: T | null = null;
  for (const sample of samples) {
    if (
      !sample.automotive ||
      sample.activityStartedAtMilliseconds >= walkingStartedAtMilliseconds
    ) {
      continue;
    }
    if (
      selected === null ||
      sample.activityStartedAtMilliseconds >=
        selected.activityStartedAtMilliseconds
    ) {
      selected = sample;
    }
  }
  return selected;
}

export function describeSmartArrivalWouldNotify(input: {
  radiusMeters?: number;
  walkingStartedAt: string;
  decisionAt: string;
  elapsedSeconds: number;
  priorAutomotive?: {
    activityStartedAt: string;
    confidence: ArrivalDiagnosticActivityConfidence;
    source: ArrivalDiagnosticActivitySource;
  } | null;
}): string {
  const radiusMeters = input.radiusMeters ?? ARRIVAL_DIAGNOSTIC_RADIUS_METERS;
  const prior = input.priorAutomotive
    ? `priorAutomotiveStart=${input.priorAutomotive.activityStartedAt};priorAutomotiveConfidence=${input.priorAutomotive.confidence};priorAutomotiveSource=${input.priorAutomotive.source}`
    : 'priorAutomotive=none';
  return `radiusMeters=${radiusMeters};walkingStartedAt=${input.walkingStartedAt};decisionAt=${input.decisionAt};elapsedSeconds=${input.elapsedSeconds.toFixed(3)};${prior}`;
}

const HISTORY_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export class ArrivalDiagnosticHistoryWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArrivalDiagnosticHistoryWindowError';
  }
}

export function parseArrivalDiagnosticHistoryWindow(
  from: string,
  to: string,
): { from: string; to: string } {
  const start = parseHistoryTimestamp(from);
  const end = parseHistoryTimestamp(to);
  if (start === null || end === null) {
    throw new ArrivalDiagnosticHistoryWindowError(
      'History query timestamps must be UTC ISO-8601, such as 2026-10-16T20:41:23.120Z.',
    );
  }

  const durationSeconds = (end.getTime() - start.getTime()) / 1000;
  if (durationSeconds <= 0) {
    throw new ArrivalDiagnosticHistoryWindowError(
      'History query start must be before its end.',
    );
  }
  if (durationSeconds > ARRIVAL_DIAGNOSTIC_HISTORY_QUERY_MAX_SECONDS) {
    throw new ArrivalDiagnosticHistoryWindowError(
      'History queries are limited to 30 minutes.',
    );
  }

  return {
    from: start.toISOString(),
    to: end.toISOString(),
  };
}

function parseHistoryTimestamp(value: string): Date | null {
  const match = HISTORY_TIMESTAMP.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number((match[7] ?? '0').padEnd(3, '0'));
  const date = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millis),
  );
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millis
  ) {
    return null;
  }
  return date;
}

export function diagnosticContractIsIsolated(): boolean {
  return (
    !ARRIVAL_DIAGNOSTIC_REGION_IDENTIFIER.startsWith(
      NATIVE_MANAGED_IDENTIFIER_PREFIX,
    ) &&
    NATIVE_MAX_MONITORED_STORES + 1 <= NATIVE_MAX_LOCATION_TRIGGERS
  );
}
