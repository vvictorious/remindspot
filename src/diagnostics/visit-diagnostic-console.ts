import ThereYouGoLocationNotification from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';

export type VisitDiagnosticVisit = {
  kind:
    | 'arrival'
    | 'departure'
    | 'departure-arrival-unknown'
    | 'arrival-unknown';
  arrivalDate: string | null;
  departureDate: string | null;
  latencySeconds: number | null;
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number | null;
  distanceFromTestDestinationMeters: number | null;
};

export type VisitDiagnosticEvent = {
  sequence: number;
  type: string;
  receivedAt: string;
  processId: string;
  processAgeSeconds: number;
  appState: string;
  launchedForLocation: boolean;
  authorizationStatus: string;
  accuracyAuthorization: string;
  backgroundRefreshStatus: string;
  lowPowerMode: boolean;
  detail: string | null;
  visit: VisitDiagnosticVisit | null;
};

export type VisitDiagnosticResults = {
  schemaVersion: number;
  available: boolean;
  isMonitoring: boolean;
  droppedEventCount: number;
  locationServicesEnabled: boolean;
  authorizationStatus: string;
  accuracyAuthorization: string;
  backgroundRefreshStatus: string;
  lowPowerMode: boolean;
  launchedForLocation: boolean;
  processId: string;
  testDestination: {
    name: string;
    latitude: number;
    longitude: number;
  };
  detail?: string;
  events: VisitDiagnosticEvent[];
};

export type VisitDiagnosticConsole = {
  start(): Promise<VisitDiagnosticResults>;
  stop(): Promise<VisitDiagnosticResults>;
  status(): Promise<VisitDiagnosticResults>;
  results(): Promise<VisitDiagnosticResults>;
  clear(): Promise<VisitDiagnosticResults>;
};

declare global {
  // Debug builds record CLVisit events for a temporary experiment. Release
  // bundles do not attach this helper.
  var tygVisitDiagnostic: VisitDiagnosticConsole | undefined;
}

if (__DEV__ && ThereYouGoLocationNotification !== null) {
  const nativeModule = ThereYouGoLocationNotification;
  const read = async (payload: Promise<string>) =>
    JSON.parse(await payload) as VisitDiagnosticResults;
  globalThis.tygVisitDiagnostic = {
    start: () => read(nativeModule.startVisitDiagnosticAsync()),
    stop: () => read(nativeModule.stopVisitDiagnosticAsync()),
    status: () => read(nativeModule.getVisitDiagnosticResultsAsync()),
    results: () => read(nativeModule.getVisitDiagnosticResultsAsync()),
    clear: () => read(nativeModule.clearVisitDiagnosticResultsAsync()),
  };
}
