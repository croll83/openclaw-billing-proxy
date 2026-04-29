const fs = require('fs');

function getToken(credsPath) {
  let raw = fs.readFileSync(credsPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('No OAuth token. Run "claude auth login".');
  return oauth;
}

module.exports = { getToken };