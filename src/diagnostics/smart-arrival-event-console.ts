import ThereYouGoLocationNotification, {
  type SmartArrivalDevelopmentEventHistory,
} from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';

export type SmartArrivalEventConsole = {
  history(): Promise<SmartArrivalDevelopmentEventHistory>;
  clear(): Promise<SmartArrivalDevelopmentEventHistory>;
};

declare global {
  // Development builds expose the production Smart Arrival event history in
  // React Native DevTools. Release bundles do not attach this helper.
  var tygSmartArrivalEvents: SmartArrivalEventConsole | undefined;
}

if (__DEV__ && ThereYouGoLocationNotification !== null) {
  const nativeModule = ThereYouGoLocationNotification;
  globalThis.tygSmartArrivalEvents = {
    history: () => nativeModule.getSmartArrivalEventHistoryAsync(),
    clear: () => nativeModule.clearSmartArrivalEventHistoryAsync(),
  };
}
