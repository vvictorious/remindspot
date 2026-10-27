import ThereYouGoLocationNotification, {
  type BackgroundDiscoveryDevelopmentEventHistory,
} from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';

export type BackgroundDiscoveryConsole = {
  history(): Promise<BackgroundDiscoveryDevelopmentEventHistory>;
  clear(): Promise<BackgroundDiscoveryDevelopmentEventHistory>;
  simulate(
    latitude: number,
    longitude: number,
    horizontalAccuracyMeters?: number,
  ): Promise<unknown>;
  validate(): Promise<{ passed: boolean; failures: string[] }>;
};

declare global {
  // Development builds expose background discovery history and a visit
  // simulation. Release bundles do not attach this helper.
  var tygBackgroundDiscovery: BackgroundDiscoveryConsole | undefined;
}

if (__DEV__ && ThereYouGoLocationNotification !== null) {
  const nativeModule = ThereYouGoLocationNotification;
  globalThis.tygBackgroundDiscovery = {
    history: () => nativeModule.getBackgroundDiscoveryEventHistoryAsync(),
    clear: () => nativeModule.clearBackgroundDiscoveryEventHistoryAsync(),
    simulate: async (latitude, longitude, horizontalAccuracyMeters = 30) =>
      JSON.parse(
        await nativeModule.debugSimulateBackgroundVisitAsync(
          latitude,
          longitude,
          horizontalAccuracyMeters,
        ),
      ) as unknown,
    validate: async () =>
      JSON.parse(
        await nativeModule.debugValidateBackgroundDiscoveryAsync(),
      ) as { passed: boolean; failures: string[] },
  };
}

export {};
