const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PORT = 18801;
const UPSTREAM_HOST = 'api.anthropic.com';
const GEMINI_HOST = 'cloudcode-pa.googleapis.com';
const GEMINI_PATH = '/v1internal:streamGenerateContent?alt=sse';
const GEMINI_PROJECT = 'engaged-fuze-66c0n';
const VERSION = '2.1.0';

const BILLING_BLOCK = '{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.156.8c7; cc_entrypoint=sdk-cli; cch=edf4c;"}';

const DEFAULT_REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
  'extended-cache-ttl-2025-04-11'
];

const OPUS_ONLY_BETAS = [
  'context-1m-2025-08-07'
];

const CC_TOOL_STUBS = [
  '{"name":"Agent","description":"Launch a subagent for complex tasks","input_schema":{"type":"object","properties":{"prompt":{"type":"string","description":"Task description"}},"required":["prompt"]}}',
  '{"name":"AskUserQuestion","description":"Ask the user a question","input_schema":{"type":"object","properties":{"question":{"type":"string"}},"required":["question"]}}',
  '{"name":"Bash","description":"Execute a bash command","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}',
  '{"name":"CronCreate","description":"Create a cron job","input_schema":{"type":"object","properties":{"schedule":{"type":"string"},"command":{"type":"string"}},"required":["schedule","command"]}}',
  '{"name":"CronDelete","description":"Delete a cron job","input_schema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}',
  '{"name":"CronList","description":"List cron jobs","input_schema":{"type":"object","properties":{}}}',
  '{"name":"Edit","description":"Edit a file","input_schema":{"type":"object","properties":{"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["file_path","old_string","new_string"]}}',
  '{"name":"EnterPlanMode","description":"Enter plan mode","input_schema":{"type":"object","properties":{}}}',
  '{"name":"EnterWorktree","description":"Enter a git worktree","input_schema":{"type":"object","properties":{}}}',
  '{"name":"ExitPlanMode","description":"Exit plan mode","input_schema":{"type":"object","properties":{}}}',
  '{"name":"ExitWorktree","description":"Exit git worktree","input_schema":{"type":"object","properties":{}}}',
  '{"name":"Glob","description":"Find files by pattern","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}',
  '{"name":"Grep","description":"Search file contents","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern"},"path":{"type":"string","description":"Search path"}},"required":["pattern"]}}',
  '{"name":"Monitor","description":"Monitor a process","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}',
  '{"name":"NotebookEdit","description":"Edit notebook cells","input_schema":{"type":"object","properties":{"notebook_path":{"type":"string"},"cell_index":{"type":"integer"}},"required":["notebook_path"]}}',
  '{"name":"PushNotification","description":"Send a push notification","input_schema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}',
  '{"name":"Read","description":"Read a file","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}',
  '{"name":"RemoteTrigger","description":"Trigger a remote action","input_schema":{"type":"object","properties":{"action":{"type":"string"}},"required":["action"]}}',
  '{"name":"ScheduleWakeup","description":"Schedule a wakeup","input_schema":{"type":"object","properties":{"delaySeconds":{"type":"number"}},"required":["delaySeconds"]}}',
  '{"name":"SendMessage","description":"Send a message","input_schema":{"type":"object","properties":{"to":{"type":"string"},"message":{"type":"string"}},"required":["to","message"]}}',
  '{"name":"Skill","description":"Execute a skill","input_schema":{"type":"object","properties":{"skill":{"type":"string"}},"required":["skill"]}}',
  '{"name":"TaskCreate","description":"Create a task","input_schema":{"type":"object","properties":{"description":{"type":"string"}},"required":["description"]}}',
  '{"name":"TaskGet","description":"Get task details","input_schema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}',
  '{"name":"TaskList","description":"List tasks","input_schema":{"type":"object","properties":{}}}',
  '{"name":"TaskOutput","description":"Get task output","input_schema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}',
  '{"name":"TaskStop","description":"Stop a task","input_schema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}',
  '{"name":"TaskUpdate","description":"Update a task","input_schema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}',
  '{"name":"TeamCreate","description":"Create a team","input_schema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}',
  '{"name":"TeamDelete","description":"Delete a team","input_schema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}',
  '{"name":"WebFetch","description":"Fetch a web page","input_schema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}',
  '{"name":"WebSearch","description":"Search the web","input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}',
  '{"name":"Workflow","description":"Run a workflow","input_schema":{"type":"object","properties":{"script":{"type":"string"}},"required":["script"]}}',
  '{"name":"Write","description":"Write a file","input_schema":{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]}}'
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
    bindAddress: config.bindAddress || '0.0.0.0',
    credsPath,
    replacements: config.replacements || DEFAULT_REPLACEMENTS,
    reverseMap: config.reverseMap || DEFAULT_REVERSE_MAP,
    stripSystemConfig: config.stripSystemConfig !== false,
    injectCCStubs: config.injectCCStubs !== false,
    geminiClientId,
    geminiClientSecret,
    requiredBetas,
    opusOnlyBetas: config.opusOnlyBetas || OPUS_ONLY_BETAS,
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