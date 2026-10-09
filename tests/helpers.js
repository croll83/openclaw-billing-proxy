const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load(relative, overrides = {}, extra = '', globals = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + extra, {
    module, exports: module.exports,
    require: name => overrides[name] || nativeRequire(name),
    console: { log() {}, error() {} }, Buffer, process, setTimeout, clearTimeout, ...globals,
  }, { filename });
  return module.exports;
}

function config() {
  return load('src/config.js', {}, '\nmodule.exports = { replacements: DEFAULT_REPLACEMENTS, reverseMap: DEFAULT_REVERSE_MAP, BILLING_BLOCK, CC_TOOL_STUBS, requiredBetas: DEFAULT_REQUIRED_BETAS, opusOnlyBetas: OPUS_ONLY_BETAS };');
}

module.exports = { load, config };
