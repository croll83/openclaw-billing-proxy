const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PORT = 18801;
const UPSTREAM_HOST = 'api.anthropic.com';
const GEMINI_HOST = 'cloudcode-pa.googleapis.com';
const GEMINI_PATH = '/v1internal:streamGenerateContent?alt=sse';
const GEMINI_PROJECT = 'engaged-fuze-66c0n';
const VERSION = '2.0.0';

const BILLING_BLOCK = '{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=57806;"}';

const DEFAULT_REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24'
];

const CC_TOOL_STUBS = [
  '{"name":"Glob","description":"Find files by pattern","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}',
  '{"name":"Grep","description":"Search file contents","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern"},"path":{"type":"string","description":"Search path"}},"required":["pattern"]}}',
  '{"name":"Agent","description":"Launch a subagent for complex tasks","input_schema":{"type":"object","properties":{"prompt":{"type":"string","description":"Task description"}},"required":["prompt"]}}',
  '{"name":"NotebookEdit","description":"Edit notebook cells","input_schema":{"type":"object","properties":{"notebook_path":{"type":"string"},"cell_index":{"type":"integer"}},"required":["notebook_path"]}}',
  '{"name":"TodoRead","description":"Read current task list","input_schema":{"type":"object","properties":{}}}'
];

const DEFAULT_REPLACEMENTS = [
  ['~/.hermes/', '~/.config/app/'],
  ['hermes_tools', 'code_tools'],
  ['hermes_telegram', 'tg_channel'],
  ['hermes-secrets.env', 'secrets.env'],
  ['Plan mode for Hermes', 'Plan mode'],
  ['hermes_cli', 'cli_module'],
  ['from hermes', 'from app'],
  ['Hermes', 'Assistant'],
  ['HERMES_', 'APP_'],
  ['HERMES', 'APP'],
  ['hermes', 'assistant'],
  ['OpenClaw', 'CLI'],
  ['openclaw', 'cli'],
  ['OPENCLAW', 'CLI'],
  ['Telegram', 'Channel'],
  ['telegram', 'channel'],
  ['Discord', 'Forum'],
  ['discord', 'forum'],
  ['WhatsApp', 'IM'],
  ['whatsapp', 'im'],
  ['Mattermost', 'Workspace'],
  ['mattermost', 'workspace'],
  ['Slack', 'Channel'],
  ['slack', 'channel'],
  ['billing proxy', 'routing layer'],
  ['billing-proxy', 'routing-layer']
];

const DEFAULT_REVERSE_MAP = [
  ['~/.config/app/', '~/.hermes/'],
  ['code_tools', 'hermes_tools'],
  ['tg_channel', 'hermes_telegram'],
  ['secrets.env', 'hermes-secrets.env'],
  ['Plan mode', 'Plan mode for Hermes'],
  ['cli_module', 'hermes_cli'],
  ['from app', 'from hermes'],
  ['routing layer', 'billing proxy'],
  ['routing-layer', 'billing-proxy']
];

function loadConfig() {
  const args = process.argv.slice(2);
  let configPath = null;
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1]);
    if (args[i] === '--config' && args[i + 1]) configPath = args[i + 1];
  }

  let config = {};
  if (configPath && fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (fs.existsSync('config.json')) {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  }

  const homeDir = os.homedir();
  const credsPaths = [
    config.credentialsPath,
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json')
  ].filter(Boolean);

  let credsPath = null;
  for (const p of credsPaths) {
    const resolved = p.startsWith('~') ? path.join(homeDir, p.slice(1)) : p;
    if (fs.existsSync(resolved) && fs.statSync(resolved).size > 0) {
      credsPath = resolved;
      break;
    }
  }

  if (!credsPath) {
    console.error('[ERROR] Claude Code credentials not found. Run "claude auth login" first.');
    console.error('Searched:');
    for (const p of credsPaths) console.error('  ' + p);
    process.exit(1);
  }

  const geminiClientId = config.geminiClientId || null;
  const geminiClientSecret = config.geminiClientSecret || null;
  const requiredBetas = config.requiredBetas || DEFAULT_REQUIRED_BETAS;

  return {
    port: config.port || port,
    credsPath,
    replacements: config.replacements || DEFAULT_REPLACEMENTS,
    reverseMap: config.reverseMap || DEFAULT_REVERSE_MAP,
    stripSystemConfig: config.stripSystemConfig !== false,
    injectCCStubs: config.injectCCStubs !== false,
    geminiClientId,
    geminiClientSecret,
    requiredBetas,
    VERSION,
    UPSTREAM_HOST,
    GEMINI_HOST,
    GEMINI_PATH,
    GEMINI_PROJECT,
    BILLING_BLOCK,
    CC_TOOL_STUBS
  };
}

module.exports = { loadConfig };