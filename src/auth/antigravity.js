const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const HOST = 'daily-cloudcode-pa.googleapis.com';
const USER_AGENT = 'antigravity/cli/1.4.3 (aidev_client; os_type=linux; arch=amd64; cl=1002753436; auth_method=consumer)';
const PROFILE = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
function failure(message, status = 502, code) {
  return Object.assign(new Error(message), { status, code });
}
function readCredentials(config = {}) {
  try {
    const filename = fs.realpathSync(config.geminiCredentialsPath || path.join(os.homedir(), PROFILE));
    if (fs.statSync(filename).size > 1024 * 1024) throw new Error();
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const token = data.token;
    if (!token || typeof token.access_token !== 'string' || !token.access_token ||
        !Number.isFinite(Date.parse(token.expiry))) throw new Error();
    return { filename, accessToken: token.access_token, expiresAt: Date.parse(token.expiry) };
  } catch {
    throw failure('Antigravity login unavailable; sign in with agy on the proxy host', 503, 'LOGIN_REQUIRED');
  }
}

// Only credential renewal uses the official CLI. Inference never starts its agent.
// HOME is derived from the registered profile, so accounts cannot refresh each other.
function renewWithCLI(filename, config) {
  if (!filename.endsWith(path.sep + PROFILE)) {
    throw failure('Antigravity renewal requires a standard HOME/.gemini/antigravity-cli profile', 503, 'LOGIN_REQUIRED');
  }
  const home = filename.slice(0, -(PROFILE.length + 1));
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8',
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share') };
    const child = spawn(config.antigravityCommand || 'agy', ['models'], {
      cwd: home, env, stdio: 'ignore', shell: false,
    });
    let timedOut = false, force;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, 30000);
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); };
    child.once('error', () => { cleanup(); reject(failure('Antigravity renewal CLI could not start', 503)); });
    child.once('close', code => {
      cleanup();
      if (timedOut) reject(failure('Antigravity credential renewal timed out after 30 seconds', 503));
      else if (code !== 0) reject(failure('Antigravity login requires reconnection with agy', 503, 'LOGIN_REQUIRED'));
      else resolve();
    });
  });
}

function createClient({ fetcher = fetch, renew = renewWithCLI, now = Date.now } = {}) {
  const refreshes = new Map(), discovery = new Map();
  async function validToken(config) {
    let creds = readCredentials(config);
    if (creds.expiresAt > now() + 60000) return creds;
    if (!refreshes.has(creds.filename)) {
      const pending = Promise.resolve().then(() => renew(creds.filename, config))
        .finally(() => refreshes.delete(creds.filename));
      refreshes.set(creds.filename, pending);
    }
    await refreshes.get(creds.filename);
    creds = readCredentials(config);
    if (creds.expiresAt <= now()) throw failure('Antigravity credentials remain expired after renewal', 503, 'LOGIN_REQUIRED');
    return creds;
  }
  async function json(action, body, session) {
    let response;
    try {
      response = await fetcher(`https://${HOST}/v1internal:${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json', 'user-agent': session.userAgent },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(failure(`Antigravity ${action} HTTP ${response.status}`,
          response.status === 401 ? 503 : response.status,
          response.status === 401 ? 'LOGIN_REQUIRED' : undefined), { upstreamStatus: response.status,
          retryAfter: response.headers.get('retry-after') });
      }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw failure('Antigravity metadata response too large'); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error.status) throw error;
      throw failure('Antigravity metadata request failed or timed out');
    }
  }
  async function session(config = {}) {
    const creds = await validToken(config);
    const userAgent = config.antigravityUserAgent || USER_AGENT;
    const previous = discovery.get(creds.filename);
    if (previous && previous.token === creds.accessToken && previous.userAgent === userAgent && previous.until > now()) {
      return previous.pending;
    }
    const result = { accessToken: creds.accessToken, userAgent, host: HOST };
    const entry = { token: creds.accessToken, userAgent, until: now() + 300000 };
    entry.pending = json('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, result).then(data => {
      if (typeof data.cloudaicompanionProject !== 'string' || !data.cloudaicompanionProject) {
        throw failure('Antigravity did not return an eligible cloud project', 503);
      }
      return { ...result, project: data.cloudaicompanionProject };
    }).catch(error => {
      if (discovery.get(creds.filename) === entry) discovery.delete(creds.filename);
      throw error;
    });
    if (discovery.size >= 256) discovery.delete(discovery.keys().next().value);
    discovery.set(creds.filename, entry);
    return entry.pending;
  }
  async function quota(config) {
    const auth = await session(config);
    const [catalog, summary] = await Promise.all([
      json('fetchAvailableModels', { project: auth.project }, auth),
      json('retrieveUserQuotaSummary', { project: auth.project }, auth),
    ]);
    // Model quotas drive admission. Group/window labels are display-only: do not
    // guess which models share a group or fabricate a 5-hour/weekly percentage.
    const valid = q => q && Number.isFinite(q.remainingFraction) && q.remainingFraction >= 0 && q.remainingFraction <= 1;
    const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
    const label = value => typeof value === 'string' ? value.slice(0, 200) : '';
    return {
      buckets: Object.entries(catalog.models || {}).slice(0, 200).filter(([, m]) => valid(m.quotaInfo))
        .map(([modelId, m]) => ({ modelId: label(modelId), remainingFraction: m.quotaInfo.remainingFraction,
          resetTime: time(m.quotaInfo.resetTime) })),
      groups: (Array.isArray(summary.groups) ? summary.groups : []).slice(0, 20).map(g => ({
        displayName: label(g.displayName),
        buckets: (Array.isArray(g.buckets) ? g.buckets : []).slice(0, 20).filter(valid).map(b => ({
          bucketId: label(b.bucketId), displayName: label(b.displayName), window: label(b.window),
          remainingFraction: b.remainingFraction, resetTime: time(b.resetTime),
        })),
      })),
    };
  }
  return { session, quota };
}
const client = createClient();
module.exports = { ...client, createClient, readCredentials, HOST, USER_AGENT };
