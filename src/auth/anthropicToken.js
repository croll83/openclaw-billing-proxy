const fs = require('fs');
const https = require('https');

const OAUTH_TOKEN_URL = 'platform.claude.com';
const OAUTH_TOKEN_PATH = '/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

let refreshInProgress = null;

function getToken(credsPath) {
  let raw = fs.readFileSync(credsPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('No OAuth token. Run "claude auth login".');
  return oauth;
}

function isTokenExpired(oauth) {
  if (!oauth.expiresAt) return false;
  return Date.now() >= oauth.expiresAt - REFRESH_SKEW_MS;
}

function refreshToken(credsPath) {
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = new Promise((resolve, reject) => {
    let raw = fs.readFileSync(credsPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;

    if (!oauth?.refreshToken) {
      refreshInProgress = null;
      return reject(new Error('No refresh token available'));
    }

    // Re-check: another request might have refreshed already
    if (!isTokenExpired(oauth)) {
      refreshInProgress = null;
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
        refreshInProgress = null;
        try {
          const resp = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200 || !resp.access_token) {
            return reject(new Error(`Token refresh failed (${res.statusCode}): ${resp.error || 'unknown'}`));
          }

          oauth.accessToken = resp.access_token;
          if (resp.refresh_token) oauth.refreshToken = resp.refresh_token;
          oauth.expiresAt = Date.now() + (resp.expires_in * 1000);
          creds.claudeAiOauth = oauth;
          fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));

          const h = (resp.expires_in / 3600).toFixed(1);
          console.log(`[AUTH] Token refreshed, expires in ${h}h`);
          resolve(oauth);
        } catch (e) {
          reject(new Error('Token refresh parse error: ' + e.message));
        }
      });
    });

    req.on('error', (e) => {
      refreshInProgress = null;
      reject(new Error('Token refresh network error: ' + e.message));
    });

    req.setTimeout(15000, () => {
      req.destroy();
      refreshInProgress = null;
      reject(new Error('Token refresh timeout'));
    });

    req.write(body);
    req.end();
  });

  return refreshInProgress;
}

async function getValidToken(credsPath) {
  let oauth = getToken(credsPath);
  if (isTokenExpired(oauth)) {
    oauth = await refreshToken(credsPath);
  }
  return oauth;
}

module.exports = { getToken, refreshToken, isTokenExpired, getValidToken };
