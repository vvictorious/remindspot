const ARRIVAL_DIAGNOSTIC_ENABLED =
  process.env.TYG_IOS_ARRIVAL_DIAGNOSTIC === '1';
const DEFAULT_ALWAYS_PERMISSION =
  'Allow $(PRODUCT_NAME) to access your location';
const DIAGNOSTIC_ALWAYS_PERMISSION =
  'Allow ThereYouGo to collect brief location samples after entering one test store for an arrival-timing diagnostic.';
const DIAGNOSTIC_MOTION_PERMISSION =
  'Allow ThereYouGo to record brief motion-activity classifications during one test-store arrival diagnostic.';

module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    infoPlist: {
      ...config.ios?.infoPlist,
      TYGArrivalDiagnosticEnabled: ARRIVAL_DIAGNOSTIC_ENABLED,
    },
  },
  plugins: (config.plugins ?? []).map((plugin) => {
    const [name, options = {}] = Array.isArray(plugin) ? plugin : [plugin, {}];

    if (name !== 'expo-location') {
      return plugin;
    }

    return [
      name,
      {
        ...options,
        isIosBackgroundLocationEnabled: true,
        locationAlwaysAndWhenInUsePermission: ARRIVAL_DIAGNOSTIC_ENABLED
          ? DIAGNOSTIC_ALWAYS_PERMISSION
          : (options.locationAlwaysAndWhenInUsePermission ??
            DEFAULT_ALWAYS_PERMISSION),
        locationAlwaysPermission: ARRIVAL_DIAGNOSTIC_ENABLED
          ? DIAGNOSTIC_ALWAYS_PERMISSION
          : (options.locationAlwaysPermission ?? DEFAULT_ALWAYS_PERMISSION),
        motionUsagePermission: ARRIVAL_DIAGNOSTIC_ENABLED
          ? DIAGNOSTIC_MOTION_PERMISSION
          : options.motionUsagePermission,
      },
    ];
  }),
});
