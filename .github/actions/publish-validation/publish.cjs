const { spawnSync } = require('node:child_process');

// A JavaScript action receives the runner's scoped artifact credentials. The
// validated Node version on PATH runs the SDK, without exposing those values.
const result = spawnSync('node', ['tools/validation-reuse.mjs', 'publish', process.env.INPUT_CONTEXT, process.env.INPUT_RECEIPT], {
  stdio: 'inherit', windowsHide: true,
});
process.exitCode = result.status ?? 1;
