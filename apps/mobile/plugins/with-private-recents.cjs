const { withMainActivity } = require('expo/config-plugins');

module.exports = config => withMainActivity(config, next => {
  const marker = '// Keep financial data out of Android task snapshots.';
  if (next.modResults.contents.includes(marker)) return next;
  const anchor = 'super.onCreate(null)';
  if (next.modResults.language !== 'kt' || !next.modResults.contents.includes(anchor)) {
    throw new Error('Unsupported MainActivity template for private recents');
  }
  next.modResults.contents = next.modResults.contents.replace(anchor, `${anchor}
    ${marker}
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
      setRecentsScreenshotEnabled(false)
    }`);
  return next;
});
