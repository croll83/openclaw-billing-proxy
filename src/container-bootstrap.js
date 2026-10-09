// Kubernetes sets workingDir=/data and mounts a volume over that directory.
// Materialize only the relative entrypoint link there; runtime code stays in /app.
const fs = require('node:fs');
const path = require('node:path');
if (process.cwd() === '/data' && path.resolve(process.argv[1] || '') === '/data/index.js') {
  const target = '/app/index.js';
  try { fs.symlinkSync(target, '/data/index.js'); }
  catch (error) {
    if (error.code !== 'EEXIST' || fs.realpathSync('/data/index.js') !== target) {
      throw new Error('Unable to initialize application entrypoint in data directory');
    }
  }
}
