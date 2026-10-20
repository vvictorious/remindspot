import { requireOptionalNativeModule } from 'expo';

export type LocationNotificationRequest = {
  identifier: string;
  title: string;
  body: string;
  latitude: number;
  longitude: number;
  radius: number;
};

export type ScheduledLocationNotification = LocationNotificationRequest & {
  notifyOnEntry: boolean;
  notifyOnExit: boolean;
  repeats: boolean;
};

export type NativeCandidateCoordinates = {
  latitude: number;
  longitude: number;
};

export type NativeCandidateItem = {
  id: string;
  revision: number;
  text: string;
  categories: string[];
};

export type NativeCandidateStore = {
  placeId: string;
  name: string;
  location: NativeCandidateCoordinates;
  itemIds: string[];
};

export type NativeCandidateSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  discoveryAnchor: NativeCandidateCoordinates;
  items: NativeCandidateItem[];
  stores: NativeCandidateStore[];
};

export type NativeItemReference = {
  id: string;
  revision: number;
};

export type NativeRequestStatus = 'pending' | 'consumed';

export type NativeRequestState = {
  placeId: string;
  installationId: string;
  fingerprint: string;
  status: NativeRequestStatus;
  items: NativeItemReference[];
  isPending: boolean;
};

export type NativeGeofenceState = {
  schemaVersion: number;
  snapshot: NativeCandidateSnapshot | null;
  requests: NativeRequestState[];
  selectedPlaceIds: string[];
  pendingManagedRequestIds: string[];
  isDegraded: boolean;
  observationEligible: boolean;
  missingObservationRequirements: string[];
};

export type NativeSyncFailure = {
  placeId: string;
  code: string;
  message: string;
};

export type NativeSyncResult = {
  scheduledPlaceIds: string[];
  unchangedPlaceIds: string[];
  canceledPlaceIds: string[];
  consumedPlaceIds: string[];
  retainedFallbackPlaceIds: string[];
  failures: NativeSyncFailure[];
  state: NativeGeofenceState;
};

export type ArrivalDiagnosticEvent = {
  sequence: number;
  type: string;
  recordedAt: string;
  appState: string;
  detail: string | null;
  locationTimestamp: string | null;
  horizontalAccuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  speedAccuracyMetersPerSecond: number | null;
  distanceFromStoreMeters: number | null;
  sampleAgeSeconds: number | null;
  isFreshLocation: boolean | null;
  executionDurationSeconds: number | null;
  activityStartTimestamp: string | null;
  activityAutomotive: boolean | null;
  activityStationary: boolean | null;
  activityWalking: boolean | null;
  activityRunning: boolean | null;
  activityUnknown: boolean | null;
  activityCycling: boolean | null;
  activityConfidence: string | null;
  observationIdentifier: string | null;
};

export type ArrivalDiagnosticStatus = {
  buildEnabled: boolean;
  isArmed: boolean;
  authorizationStatus: string;
  accuracyAuthorization: string;
  backgroundRefreshStatus: string;
  backgroundModeEnabled: boolean;
  regionMonitoringAvailable: boolean;
  diagnosticRegionRegistered: boolean;
  serviceSessionSupported: boolean;
  serviceSessionActive: boolean;
  liveUpdatesSupported: boolean;
  observationActive: boolean;
  observationDeadline: string | null;
  observationDurationSeconds: number;
  /** @deprecated Use observationActive. */
  burstActive: boolean;
  pendingLocationNotificationCount: number;
  monitoredRegionCount: number;
  conservativeOccupiedRegionCount: number;
  regionLimit: number;
  storeIdentifier: string;
  storeName: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  /** @deprecated Use observationDurationSeconds. */
  burstDurationSeconds: number;
  motionAvailable: boolean;
  motionAuthorizationStatus: string;
};

export type ArrivalDiagnosticResults = {
  schemaVersion: number;
  storeIdentifier: string;
  storeName: string;
  radiusMeters: number;
  isArmed: boolean;
  events: ArrivalDiagnosticEvent[];
};

export type ArrivalDiagnosticHistoryConfidence =
  | 'low'
  | 'medium'
  | 'high'
  | 'unknown';

export type ArrivalDiagnosticActivitySample = {
  activityStartTimestamp: string;
  automotive: boolean;
  stationary: boolean;
  walking: boolean;
  running: boolean;
  cycling: boolean;
  unknown: boolean;
  confidence: ArrivalDiagnosticHistoryConfidence;
};

export type ArrivalDiagnosticHistoryQuery = {
  outcome: 'activities' | 'no-activity';
  from: string;
  to: string;
  detail: string | null;
  activities: ArrivalDiagnosticActivitySample[];
};

export type ThereYouGoLocationNotificationModule = {
  scheduleAsync(request: LocationNotificationRequest): Promise<string>;
  getScheduledAsync(
    identifier: string,
  ): Promise<ScheduledLocationNotification | null>;
  cancelAsync(identifier: string): Promise<boolean>;
  syncAsync(snapshot: NativeCandidateSnapshot): Promise<NativeSyncResult>;
  getStateAsync(): Promise<NativeGeofenceState>;
  armArrivalDiagnosticAsync(): Promise<ArrivalDiagnosticStatus>;
  getArrivalDiagnosticStatusAsync(): Promise<ArrivalDiagnosticStatus>;
  getArrivalDiagnosticResultsAsync(): Promise<ArrivalDiagnosticResults>;
  clearArrivalDiagnosticResultsAsync(): Promise<ArrivalDiagnosticResults>;
  disableArrivalDiagnosticAsync(): Promise<ArrivalDiagnosticStatus>;
  queryArrivalActivityHistoryAsync(
    from: string,
    to: string,
  ): Promise<ArrivalDiagnosticHistoryQuery>;
};

export default requireOptionalNativeModule<ThereYouGoLocationNotificationModule>(
  'ThereYouGoLocationNotification',
);
