import {
  NATIVE_GEOFENCE_RADIUS_METERS,
  NATIVE_MANAGED_IDENTIFIER_PREFIX,
  NATIVE_MAX_LOCATION_TRIGGERS,
  isManagedInstallationId,
} from './geofence-native-contract';
import { SMART_ARRIVAL_OBSERVATION_SECONDS } from './smart-arrival-state';

export const SMART_ARRIVAL_MINIMUM_IOS_MAJOR_VERSION = 18;
export const SMART_ARRIVAL_REGION_NOTIFY_ON_ENTRY = true;
export const SMART_ARRIVAL_REGION_NOTIFY_ON_EXIT = false;
export const SMART_ARRIVAL_REGION_COORDINATE_TOLERANCE = 0.000_001;
export const SMART_ARRIVAL_REGION_RADIUS_TOLERANCE_METERS = 0.01;
export const SMART_ARRIVAL_HISTORICAL_MOTION_LOOKBACK_SECONDS = 120;
export const SMART_ARRIVAL_MAXIMUM_HISTORICAL_ACTIVITIES = 16;

export type SmartArrivalRuntimeEligibility = {
  iosMajorVersion: number;
  regionMonitoringAvailable: boolean;
};

export type SmartArrivalMonitoredRegion = {
  identifier: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  notifyOnEntry: boolean;
  notifyOnExit: boolean;
};

export type SmartArrivalDesiredRegion = {
  identifier: string;
  latitude: number;
  longitude: number;
  radiusMeters?: number;
};

export type SmartArrivalObservationDeadline = {
  identifier: string;
  deadline: string;
};

export const SMART_ARRIVAL_OBSERVATION_REQUIREMENTS = [
  'ios-version',
  'region-monitoring',
  'always-location',
  'precise-location',
  'motion',
  'notifications',
] as const;

export type SmartArrivalObservationRequirement =
  (typeof SMART_ARRIVAL_OBSERVATION_REQUIREMENTS)[number];

export type SmartArrivalObservationEligibility = {
  iosMajorVersion: number;
  regionMonitoringAvailable: boolean;
  authorizedAlways: boolean;
  preciseLocation: boolean;
  motionAuthorized: boolean;
  notificationsAuthorized: boolean;
};

export function isSmartArrivalRuntimeEligible(
  input: SmartArrivalRuntimeEligibility,
): boolean {
  return (
    Number.isInteger(input.iosMajorVersion) &&
    input.iosMajorVersion >= SMART_ARRIVAL_MINIMUM_IOS_MAJOR_VERSION &&
    input.regionMonitoringAvailable
  );
}

export function missingSmartArrivalObservationRequirements(
  input: SmartArrivalObservationEligibility,
): SmartArrivalObservationRequirement[] {
  const missing: SmartArrivalObservationRequirement[] = [];
  if (
    !Number.isInteger(input.iosMajorVersion) ||
    input.iosMajorVersion < SMART_ARRIVAL_MINIMUM_IOS_MAJOR_VERSION
  ) {
    missing.push('ios-version');
  }
  if (!input.regionMonitoringAvailable) {
    missing.push('region-monitoring');
  }
  if (!input.authorizedAlways) {
    missing.push('always-location');
  }
  if (!input.preciseLocation) {
    missing.push('precise-location');
  }
  if (!input.motionAuthorized) {
    missing.push('motion');
  }
  if (!input.notificationsAuthorized) {
    missing.push('notifications');
  }
  return missing;
}

export function isSmartArrivalObservationEligible(
  input: SmartArrivalObservationEligibility,
): boolean {
  return missingSmartArrivalObservationRequirements(input).length === 0;
}

export function smartArrivalInstallationIsDegraded(input: {
  selectedIsDegraded: boolean;
  hasPendingCancellations: boolean;
  hasDeliveryIntents: boolean;
  hasInstalledManagedRegion: boolean;
  observationEligible: boolean;
}): boolean {
  return (
    input.selectedIsDegraded ||
    input.hasPendingCancellations ||
    input.hasDeliveryIntents ||
    (input.hasInstalledManagedRegion && !input.observationEligible)
  );
}

export function shouldFallbackToImmediateGeofenceNotification(): false {
  return false;
}

export function conservativeOccupiedRegionIdentifiers(
  pendingLocationNotificationIds: readonly string[],
  monitoredRegionIds: readonly string[],
): string[] {
  return [
    ...new Set([...pendingLocationNotificationIds, ...monitoredRegionIds]),
  ].sort();
}

export function canRegisterAdditionalRegion(input: {
  occupiedIdentifiers: readonly string[];
  reusableIdentifier?: string;
  regionLimit?: number;
}): boolean {
  const occupied = new Set(input.occupiedIdentifiers);
  const limit = input.regionLimit ?? NATIVE_MAX_LOCATION_TRIGGERS;
  if (
    input.reusableIdentifier !== undefined &&
    occupied.has(input.reusableIdentifier)
  ) {
    return true;
  }
  return occupied.size < limit;
}

export function verifyManagedCircularRegion(
  region: SmartArrivalMonitoredRegion,
  desired: SmartArrivalDesiredRegion,
): boolean {
  const radiusMeters = desired.radiusMeters ?? NATIVE_GEOFENCE_RADIUS_METERS;
  return (
    region.identifier === desired.identifier &&
    isManagedInstallationId(region.identifier) &&
    Math.abs(region.latitude - desired.latitude) <
      SMART_ARRIVAL_REGION_COORDINATE_TOLERANCE &&
    Math.abs(region.longitude - desired.longitude) <
      SMART_ARRIVAL_REGION_COORDINATE_TOLERANCE &&
    Math.abs(region.radiusMeters - radiusMeters) <
      SMART_ARRIVAL_REGION_RADIUS_TOLERANCE_METERS &&
    region.notifyOnEntry === SMART_ARRIVAL_REGION_NOTIFY_ON_ENTRY &&
    region.notifyOnExit === SMART_ARRIVAL_REGION_NOTIFY_ON_EXIT
  );
}

export function shouldRunSharedObservationStreams(
  activeObservationCount: number,
): boolean {
  return activeObservationCount > 0;
}

export function shouldRetainAlwaysServiceSession(input: {
  pendingMonitoredRegionCount: number;
  activeObservationCount: number;
  authorizedAlways: boolean;
  preciseLocation: boolean;
}): boolean {
  return (
    input.authorizedAlways &&
    input.preciseLocation &&
    (input.pendingMonitoredRegionCount > 0 || input.activeObservationCount > 0)
  );
}

export function nextObservationDeadline(
  observations: readonly SmartArrivalObservationDeadline[],
  now: string,
): string | null {
  const nowTimestamp = Date.parse(now);
  const upcoming = observations
    .map((observation) => observation.deadline)
    .filter((deadline) => {
      const timestamp = Date.parse(deadline);
      return Number.isFinite(timestamp) && timestamp > nowTimestamp;
    })
    .sort();
  return upcoming[0] ?? null;
}

export function shouldReconstructObservationRuntime(input: {
  eligible: boolean;
  observations: readonly SmartArrivalObservationDeadline[];
  now: string;
}): boolean {
  return (
    input.eligible &&
    nextObservationDeadline(input.observations, input.now) !== null
  );
}

export function leftoverManagedLocationTriggerIds(
  pendingLocationNotificationIds: readonly string[],
): string[] {
  return pendingLocationNotificationIds
    .filter((identifier) =>
      identifier.startsWith(NATIVE_MANAGED_IDENTIFIER_PREFIX),
    )
    .sort();
}

export function observationDurationSeconds(): number {
  return SMART_ARRIVAL_OBSERVATION_SECONDS;
}
