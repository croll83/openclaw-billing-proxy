const fs = require('fs');
const https = require('https');
const path = require('path');
const { randomUUID } = require('crypto');

const OAUTH_TOKEN_URL = 'platform.claude.com';
const OAUTH_TOKEN_PATH = '/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const refreshes = new Map();

function readCredentials(credsPath) {
  return JSON.parse(fs.readFileSync(credsPath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeCredentials(credsPath, creds) {
  // Replace atomically, in the same directory, without making credentials public.
  const target = fs.realpathSync(credsPath);
  const temporary = path.join(path.dirname(target), `.credentials-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(creds, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function getToken(credsPath) {
  const creds = readCredentials(credsPath);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('No OAuth token. Run "claude auth login".');
  return oauth;
}

function isTokenExpired(oauth) {
  if (!oauth.expiresAt) return false;
  return Date.now() >= oauth.expiresAt - REFRESH_SKEW_MS;
}

function refreshToken(credsPath, { rejectedToken } = {}) {
  const key = path.resolve(credsPath);
  if (refreshes.has(key)) return refreshes.get(key);

  // Defer work so even synchronous returns/errors run after the Map assignment.
  const pending = Promise.resolve().then(() => new Promise((resolve, reject) => {
    const creds = readCredentials(credsPath);
    const oauth = creds.claudeAiOauth;

    if (!oauth?.refreshToken) {
      return reject(Object.assign(new Error('No refresh token available'), { code: 'LOGIN_REQUIRED' }));
    }

    // Re-check: another request might have refreshed already
    if (!isTokenExpired(oauth) && oauth.accessToken !== rejectedToken) {
      return resolve(oauth);
    }

    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: OAUTH_CLIENT_ID
    });

    console.log('[AUTH] Refreshing Anthropic OAuth token...');

    const req = https.request({
      hostname: OAUTH_TOKEN_URL, port: 443,
      path: OAUTH_TOKEN_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const resp = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200 || !resp.access_token) {
            return reject(Object.assign(new Error(`Token refresh failed (${res.statusCode})${resp.error === 'invalid_grant' ? ': invalid_grant' : ''}`),
              resp.error === 'invalid_grant' ? { code: 'LOGIN_REQUIRED' } : {}));
          }

          if (!Number.isFinite(resp.expires_in) || resp.expires_in <= 0) {
            return reject(new Error('Token refresh returned an invalid expiry'));
          }

          // Preserve unrelated settings and avoid overwriting a newer CLI login.
          const latest = readCredentials(credsPath);
          if (latest.claudeAiOauth?.refreshToken !== oauth.refreshToken ||
              latest.claudeAiOauth?.accessToken !== oauth.accessToken) {
            if (latest.claudeAiOauth?.accessToken && !isTokenExpired(latest.claudeAiOauth)) {
              return resolve(latest.claudeAiOauth);
            }
            return reject(new Error('Credentials changed during token refresh; retry the request'));
          }

          oauth.accessToken = resp.access_token;
          if (resp.refresh_token) oauth.refreshToken = resp.refresh_token;
          oauth.expiresAt = Date.now() + (resp.expires_in * 1000);
          latest.claudeAiOauth = { ...latest.claudeAiOauth, ...oauth };
          writeCredentials(credsPath, latest);

          const h = (resp.expires_in / 3600).toFixed(1);
          console.log(`[AUTH] Token refreshed, expires in ${h}h`);
          resolve(oauth);
        } catch (e) {
          reject(new Error('Token refresh parse error: ' + e.message));
        }
      });
      res.on('error', () => reject(new Error('Token refresh response interrupted')));
      res.on('aborted', () => reject(new Error('Token refresh response aborted')));
    });

    req.on('error', (e) => {
      reject(new Error('Token refresh network error: ' + e.message));
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Token refresh timeout'));
    });

    req.write(body);
    req.end();
  })).finally(() => refreshes.delete(key));
  refreshes.set(key, pending);
  return pending;
}

async function getValidToken(credsPath) {
  let oauth = getToken(credsPath);
  if (isTokenExpired(oauth)) {
    oauth = await refreshToken(credsPath);
  }
  return oauth;
}

module.exports = { getToken, refreshToken, isTokenExpired, getValidToken };
