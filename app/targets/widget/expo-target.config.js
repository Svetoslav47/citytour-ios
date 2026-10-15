/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// Home-screen "Next stop" widget (the HarmonyOS Form Kit card, B14). Reads the card JSON the app writes to the App Group.
module.exports = (config) => ({
  type: 'widget',
  name: 'CityTourWidget',
  deploymentTarget: '17.0',
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
});
