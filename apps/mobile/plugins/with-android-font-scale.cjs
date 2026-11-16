const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

// Keep the live React context and its picker contracts when the system font size changes.
// React Native handles the configuration callback and updates text without restarting the Activity.
module.exports = config => withAndroidManifest(config, next => {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(next.modResults);
  const changes = new Set((activity.$['android:configChanges'] || '').split('|').filter(Boolean));
  changes.add('fontScale');
  activity.$['android:configChanges'] = [...changes].join('|');
  return next;
});
