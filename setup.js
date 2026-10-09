#!/usr/bin/env node
/**
 * Setup script for Hermes Billing Proxy
 *
 * Auto-detects Claude Code credentials and Hermes installation,
 * generates config.json with transparent Anthropic defaults.
 *
 * Usage: node setup.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();

console.log('\n  Hermes Billing Proxy Setup');
console.log('  -------------------------\n');

// Step 1: Check Claude Code auth
console.log('1. Checking Claude Code authentication...');
const credsPaths = [
  path.join(homeDir, '.claude', '.credentials.json'),
  path.join(homeDir, '.claude', 'credentials.json')
];

let credsPath = null;
let creds = null;

for (const p of credsPaths) {
  if (fs.existsSync(p)) {
    const stat = fs.statSync(p);
    if (stat.size > 0) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken) {
          credsPath = p;
          creds = parsed;
          break;
        }
      } catch (e) { /* invalid JSON, skip */ }
    }
  }
}

// If no credentials found, try triggering a credential write via claude CLI
if (!creds) {
  console.log('   No credentials found. Attempting to trigger credential write...');
  const { execSync } = require('child_process');
  try {
    execSync('claude -p "ping" --max-turns 1 --no-session-persistence --output-format json 2>/dev/null', {
      timeout: 30000,
      stdio: 'pipe'
    });
    for (const p of credsPaths) {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken) {
            credsPath = p;
            creds = parsed;
            console.log('   Credential write triggered successfully: ' + p);
            break;
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) {
    // CLI not available or failed
  }
}

if (!creds) {
  console.error('   CREDENTIALS NOT FOUND.');
  console.error('');
  console.error('   Claude Code CLI must be installed and authenticated:');
  console.error('');
  console.error('     npm install -g @anthropic-ai/claude-code');
  console.error('     claude auth login');
  console.error('');
  console.error('   This opens a browser to sign in with your Claude Max/Pro account.');
  console.error('   After authenticating, run this setup script again.');
  console.error('');
  console.error('   Searched for credentials at:');
  for (const p of credsPaths) { console.error('     ' + p); }
  process.exit(1);
}

const expiresIn = ((creds.claudeAiOauth.expiresAt - Date.now()) / 3600000).toFixed(1);
console.log('   OK: ' + (creds.claudeAiOauth.subscriptionType || 'unknown') + ' subscription, token expires in ' + expiresIn + 'h');

// Step 2: Find Hermes installation
console.log('\n2. Checking Hermes installation...');
const hermesPaths = [
  '/opt/hermes-agent',
  path.join(homeDir, '.hermes')
];

let hermesPath = null;
for (const p of hermesPaths) {
  if (fs.existsSync(p)) {
    hermesPath = p;
    break;
  }
}

if (hermesPath) {
  console.log('   Found Hermes at: ' + hermesPath);
} else {
  console.log('   Hermes installation not found at standard paths (optional)');
  console.log('   Checked: ' + hermesPaths.join(', '));
}

// Step 3: Preserve caller context and tool arguments.
console.log('\n3. Using transparent Anthropic defaults (no keyword replacements)...');
const replacements = [];
const reverseMap = [];

// Step 4: Generate config
console.log('\n4. Generating configuration...');

const config = {
  port: 18801,
  credentialsPath: credsPath,
  replacements: replacements,
  reverseMap: reverseMap,
  stripSystemConfig: false,
  injectCCStubs: true,
  anthropicTimeoutMs: 3600000
};

const configPath = path.join(process.cwd(), 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('   Written: ' + configPath);
console.log('   Keyword patterns: ' + replacements.length);
console.log('   Reverse map patterns: ' + reverseMap.length);

// Step 5: Instructions
console.log('\n5. Setup complete!\n');
console.log('   Next steps:');
console.log('   -----------');
console.log('   a) Start the proxy:     node index.js');
console.log('   b) Update Hermes:       Set baseUrl to http://127.0.0.1:' + config.port);
console.log('   c) Restart Hermes:      Restart your Hermes gateway');
console.log('   d) Test:                Send a message through Hermes\n');

console.log('   Troubleshooting:');
console.log('   - If requests fail with "extra usage" errors, check proxy console for 400 status codes');
console.log('   - Validate changes with scripts/probe-anthropic.py before deploying');
console.log('   - OAuth refresh is automatic; invalid_grant requires claude auth login\n');
