// Babel config for the twenty4 Expo app.
// babel-preset-expo handles JSX, TypeScript, and the expo-router/expo-font setup.
// No Reanimated/worklets plugin is needed: this shell pulls no animation libs.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
