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

export type ThereYouGoLocationNotificationModule = {
  scheduleAsync(request: LocationNotificationRequest): Promise<string>;
  getScheduledAsync(
    identifier: string,
  ): Promise<ScheduledLocationNotification | null>;
  cancelAsync(identifier: string): Promise<boolean>;
  syncAsync(snapshot: NativeCandidateSnapshot): Promise<NativeSyncResult>;
  getStateAsync(): Promise<NativeGeofenceState>;
};

export default requireOptionalNativeModule<ThereYouGoLocationNotificationModule>(
  'ThereYouGoLocationNotification',
);
