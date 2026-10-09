const { getValidToken, refreshToken } = require('../auth/anthropicToken');
const { getGeminiTokenSync, refreshGeminiToken } = require('../auth/geminiToken');
function normalize(value) {
  const result = {};
  for (const name of ['five_hour','seven_day','seven_day_opus','seven_day_sonnet']) {
    const w = value?.[name];
    if (w && Number.isFinite(w.utilization) && w.utilization >= 0) {
      result[name] = { utilization: w.utilization,
        resets_at: typeof w.resets_at === 'string' && Number.isFinite(Date.parse(w.resets_at)) ? w.resets_at : null };
    }
  }
  return result;
}
function normalizeGemini(value) {
  return { buckets: (Array.isArray(value?.buckets) ? value.buckets : []).slice(0,200).filter(b =>
    typeof b.modelId === 'string' && b.modelId.length <= 200 && Number.isFinite(b.remainingFraction) && b.remainingFraction >= 0 && b.remainingFraction <= 1
  ).map(b => ({ modelId:b.modelId, remainingFraction:b.remainingFraction,
    resetTime: typeof b.resetTime === 'string' && Number.isFinite(Date.parse(b.resetTime)) ? b.resetTime : null })) };
}
class QuotaMonitor {
  constructor(store, { intervalMs = 120000, fetcher = fetch, tokenReader = getValidToken, geminiConfig = {}, geminiTokenReader, tokenRefresher = refreshToken } = {}) {
    this.tokenRefresher = tokenRefresher; this.suspended = new Set();
    this.store = store; this.intervalMs = intervalMs; this.fetcher = fetcher; this.tokenReader = tokenReader;
    this.geminiTokenReader = geminiTokenReader || (async account => {
      const info = getGeminiTokenSync(account.credentialsPath);
      return info.needsRefresh ? refreshGeminiToken(info.creds,info.credsPath,geminiConfig) : info.token;
    });
    this.pending = new Map(); this.lastAttempt = new Map(); this.retryAt = new Map(); this.closed = false;
  }
  async read(account) {
        const anthropic = account.provider === 'anthropic';
        const token = anthropic ? (await this.tokenReader(account.credentialsPath)).accessToken : await this.geminiTokenReader(account);
        const request = token => this.fetcher(anthropic ? 'https://api.anthropic.com/api/oauth/usage' : 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
          method: anthropic ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, ...(anthropic ? { 'anthropic-beta': 'oauth-2025-04-20' } : {'content-type':'application/json'}) },
          ...(anthropic ? {} : {body:JSON.stringify({project:account.project})}),
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        let response = await request(token);
        if (anthropic && response.status === 401) {
          await response.body?.cancel();
          const renewed = await this.tokenRefresher(account.credentialsPath,{rejectedToken:token});
          response = await request(renewed.accessToken);
        }
        if (!response.ok) {
          if (response.status === 429) {
            const header=response.headers.get('retry-after');
            const delay=header && Number.isFinite(Number(header)) ? Number(header)*1000 : Date.parse(header)-Date.now();
            this.retryAt.set(account.id,Date.now()+Math.max(30000,Number.isFinite(delay)?delay:120000));
          }
          await response.body?.cancel();
          throw Object.assign(new Error(`Usage endpoint HTTP ${response.status}`), response.status === 401 ? {code:'LOGIN_REQUIRED'} : {});
        }
        const reader = response.body.getReader(); let size = 0; const chunks = [];
        while (true) {
          const { done,value } = await reader.read(); if (done) break;
          size += value.length; if (size > 128*1024) { await reader.cancel(); throw new Error('Usage response too large'); }
          chunks.push(Buffer.from(value));
        }
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const quota = anthropic ? normalize(data) : normalizeGemini(data);
        if (anthropic ? !quota.five_hour && !quota.seven_day : !quota.buckets.length) throw new Error('Subscription windows unavailable');
        return quota;
  }
  refresh(account) {
    if (this.closed || this.suspended.has(account.id)) return Promise.resolve();
    if ((this.retryAt.get(account.id)||0)>Date.now()) return Promise.resolve();
    if (this.pending.has(account.id)) return this.pending.get(account.id);
    if (Date.now()-(this.lastAttempt.get(account.id)||0) < 30000) return Promise.resolve();
    this.lastAttempt.set(account.id,Date.now());
    const pending = (async () => {
      try {
        const quota = await this.read(account);
        if (!this.closed && this.store.accounts().some(a => a.id === account.id && a.credentialsPath === account.credentialsPath)) { this.store.quota(account.id,quota); this.store.authStatus(account.id,'ok'); }
      } catch (error) {
        // Never persist raw provider bodies or OAuth errors containing credential details.
        const message = error.code === 'LOGIN_REQUIRED' ? 'Login required: reconnect this account' : /^Usage endpoint HTTP \d+$/.test(error.message) ? error.message : 'Subscription usage unavailable';
        if (!this.closed) {
          try {
            if (this.store.accounts().some(a => a.id === account.id && a.credentialsPath === account.credentialsPath)) {
              this.store.quota(account.id,null,message);
              if (error.code === 'LOGIN_REQUIRED') this.store.authStatus(account.id,'login_required');
            }
          } catch (_) { console.error('[QUOTA] Failed to persist cloud status'); }
        }
      }
    })().finally(() => this.pending.delete(account.id));
    this.pending.set(account.id,pending); return pending;
  }
  async tick() {
    if (this.closed) return;
    this.store.prune();
    for (const account of this.store.accounts().filter(a => a.enabled)) {
      if (this.closed) break; await this.refresh(account);
    }
  }
  start() {
    const poll=()=>this.tick().catch(()=>console.error('[QUOTA] Poll failed'));
    poll(); this.timer=setInterval(poll,this.intervalMs); this.timer.unref();
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.pending.values()); }
}
module.exports = { QuotaMonitor, normalize, normalizeGemini };
