const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

function getGeminiCredsPath() {
  const homeDir = os.homedir();
  const p = path.join(homeDir, '.gemini', 'oauth_creds.json');
  if (fs.existsSync(p)) return p;
  return null;
}

function refreshGeminiToken(creds, credsPath, config) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: config.geminiClientId,
      client_secret: config.geminiClientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body.access_token) {
            creds.access_token = body.access_token;
            creds.expiry_date = Date.now() + (body.expires_in * 1000);
            if (body.id_token) creds.id_token = body.id_token;
            fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
            console.log('[GEMINI] Token refreshed');
            resolve(body.access_token);
          } else {
            reject(new Error('Gemini token refresh failed: ' + JSON.stringify(body)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getGeminiTokenSync() {
  const credsPath = getGeminiCredsPath();
  if (!credsPath) throw new Error('Gemini credentials not found at ~/.gemini/oauth_creds.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  if (!creds.access_token) throw new Error('No access_token in Gemini credentials');
  if (!creds.expiry_date || Date.now() < creds.expiry_date - 60000) {
    return { token: creds.access_token, needsRefresh: false, creds, credsPath };
  }
  return { token: creds.access_token, needsRefresh: true, creds, credsPath };
}

module.exports = {
  getGeminiCredsPath,
  refreshGeminiToken,
  getGeminiTokenSync
};