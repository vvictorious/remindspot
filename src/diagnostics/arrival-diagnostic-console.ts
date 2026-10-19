import ThereYouGoLocationNotification, {
  type ArrivalDiagnosticHistoryQuery,
  type ArrivalDiagnosticResults,
  type ArrivalDiagnosticStatus,
} from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';
import { parseArrivalDiagnosticHistoryWindow } from '../native/arrival-diagnostic-contract';

export type ArrivalDiagnosticConsole = {
  arm(): Promise<ArrivalDiagnosticStatus>;
  status(): Promise<ArrivalDiagnosticStatus>;
  results(): Promise<ArrivalDiagnosticResults>;
  clear(): Promise<ArrivalDiagnosticResults>;
  disable(): Promise<ArrivalDiagnosticStatus>;
  queryHistory(
    from: string,
    to: string,
  ): Promise<ArrivalDiagnosticHistoryQuery>;
};

declare global {
  // Diagnostic builds are controlled from the React Native DevTools console so
  // the production UI and behavior remain unchanged.
  var tygArrivalDiagnostic: ArrivalDiagnosticConsole | undefined;
}

if (__DEV__ && ThereYouGoLocationNotification !== null) {
  const diagnosticModule = ThereYouGoLocationNotification;
  globalThis.tygArrivalDiagnostic = {
    arm: () => diagnosticModule.armArrivalDiagnosticAsync(),
    status: () => diagnosticModule.getArrivalDiagnosticStatusAsync(),
    results: () => diagnosticModule.getArrivalDiagnosticResultsAsync(),
    clear: () => diagnosticModule.clearArrivalDiagnosticResultsAsync(),
    disable: () => diagnosticModule.disableArrivalDiagnosticAsync(),
    queryHistory: (from, to) => {
      const window = parseArrivalDiagnosticHistoryWindow(from, to);
      return diagnosticModule.queryArrivalActivityHistoryAsync(
        window.from,
        window.to,
      );
    },
  };
}
