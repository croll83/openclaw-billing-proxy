const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { randomUUID } = require('crypto');
const refreshes = new Map();

function getGeminiCredsPath(explicit) {
  const p = explicit || path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  return fs.existsSync(p) ? p : null;
}
function refreshGeminiToken(creds, credsPath, config) {
  const key = fs.realpathSync(credsPath);
  if (refreshes.has(key)) return refreshes.get(key);
  const pending = Promise.resolve().then(() => new Promise((resolve,reject) => {
    const latest = JSON.parse(fs.readFileSync(key,'utf8'));
    if (latest.access_token && latest.expiry_date > Date.now()+60000) { resolve(latest.access_token); return; }
    creds = latest;
    const postData = new URLSearchParams({ client_id: config.geminiClientId,
      client_secret: config.geminiClientSecret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }).toString();
    const req = https.request({ hostname:'oauth2.googleapis.com',port:443,path:'/token',method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(postData)} }, res => {
      const chunks = []; let size = 0;
      res.on('data',c => { size += c.length; if (size > 65536) { req.destroy(); reject(new Error('Gemini refresh response too large')); } else chunks.push(c); });
      res.on('error',() => reject(new Error('Gemini refresh response interrupted')));
      res.on('aborted',() => reject(new Error('Gemini refresh response aborted')));
      res.on('end',() => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200 || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error('Gemini token refresh rejected');
          const current = JSON.parse(fs.readFileSync(key,'utf8'));
          if (current.refresh_token !== creds.refresh_token || current.access_token !== creds.access_token) {
            if (current.access_token && current.expiry_date > Date.now()+60000) { resolve(current.access_token); return; }
            throw new Error('Gemini credentials changed during refresh');
          }
          Object.assign(current,{access_token:body.access_token,expiry_date:Date.now()+body.expires_in*1000});
          if (body.refresh_token) current.refresh_token = body.refresh_token;
          if (body.id_token) current.id_token = body.id_token;
          const temporary = path.join(path.dirname(key),`.oauth-${randomUUID()}.tmp`);
          try { fs.writeFileSync(temporary,JSON.stringify(current,null,2),{mode:0o600,flag:'wx'}); fs.renameSync(temporary,key); }
          finally { fs.rmSync(temporary,{force:true}); }
          resolve(body.access_token);
        } catch (_) { reject(new Error('Gemini token refresh failed')); }
      });
    });
    req.on('error',() => reject(new Error('Gemini token refresh network error')));
    req.setTimeout(15000,() => { req.destroy(); reject(new Error('Gemini token refresh timeout')); });
    req.end(postData);
  })).finally(() => refreshes.delete(key));
  refreshes.set(key,pending); return pending;
}
function getGeminiTokenSync(explicit) {
  const credsPath = getGeminiCredsPath(explicit);
  if (!credsPath) throw new Error('Gemini credentials file not found');
  const creds = JSON.parse(fs.readFileSync(credsPath,'utf8'));
  if (!creds.access_token) throw new Error('No access_token in Gemini credentials');
  return {token:creds.access_token,needsRefresh:!!creds.expiry_date && Date.now() >= creds.expiry_date-60000,creds,credsPath};
}
module.exports = { getGeminiCredsPath, refreshGeminiToken, getGeminiTokenSync };
