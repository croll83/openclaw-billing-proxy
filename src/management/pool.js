const { createHash } = require('node:crypto');
class AdmissionError extends Error {
  constructor(message, status = 429) { super(message); this.status = status; }
}
class Pool {
  constructor(store, { maxConcurrent = 32, quotaMaxAgeMs = 300000, stickyUsageThreshold = 95 } = {}) {
    if (!Number.isFinite(stickyUsageThreshold) || stickyUsageThreshold <= 0 || stickyUsageThreshold > 100) throw new Error('stickyUsageThreshold must be greater than 0 and at most 100');
    this.stickyUsageThreshold = stickyUsageThreshold;
    this.store = store; this.limit = maxConcurrent; this.quotaMaxAgeMs = quotaMaxAgeMs;
    this.active = 0; this.byKey = new Map(); this.byAccount = new Map(); this.accepting = true;
    this.suspended = new Set();
  }
  quotaBlocked(account, now, model = '') {
    if (account.provider === 'gemini') {
      if (!account.quotaUpdatedAt || now-account.quotaUpdatedAt>this.quotaMaxAgeMs) return false;
      return (account.quota?.buckets || []).some(b => b.modelId === model.replace(/^google\//,'') &&
        b.remainingFraction <= 0 && (!b.resetTime || Date.parse(b.resetTime)>now));
    }
    if (!account.quota || !account.quotaUpdatedAt || now - account.quotaUpdatedAt > this.quotaMaxAgeMs) return true;
    return ['five_hour','seven_day', ...(model.includes('opus') ? ['seven_day_opus'] : []), ...(model.includes('sonnet') ? ['seven_day_sonnet'] : [])].some(k => {
      const w = account.quota[k];
      return w && w.utilization >= 100 && (!w.resets_at || Date.parse(w.resets_at) > now);
    });
  }
  utilization(account, now, model = '') {
    if (!account.quotaUpdatedAt || now-account.quotaUpdatedAt>this.quotaMaxAgeMs) return 0;
    if (account.provider === 'gemini') return Math.max(0,...(account.quota?.buckets || [])
      .filter(b => b.modelId === model.replace(/^google\//,'') && (!b.resetTime || Date.parse(b.resetTime)>now))
      .map(b => (1-b.remainingFraction)*100));
    const windows=['five_hour','seven_day',...(model.includes('opus')?['seven_day_opus']:[]),...(model.includes('sonnet')?['seven_day_sonnet']:[])];
    return Math.max(0,...windows.map(k=>account.quota?.[k]).filter(w=>w && (!w.resets_at || Date.parse(w.resets_at)>now)).map(w=>w.utilization));
  }
  acquire(key, provider, sourceIP = '', model = '') {
    if (!this.accepting) throw new AdmissionError('Proxy is draining; retry later',503);
    if (this.active >= this.limit) throw new AdmissionError('Proxy concurrency limit reached');
    if ((this.byKey.get(key.id) || 0) >= key.maxConcurrent) throw new AdmissionError('Caller concurrency limit reached');
    const now = Date.now();
    // Socket peer only: no forwarding header or client session identifier is trusted.
    const sourceHash=createHash('sha256').update(sourceIP.toLowerCase().replace(/^::ffff:/,'')).digest('hex');
    const accounts=this.store.accounts().filter(a=>a.provider===provider);
    const preferredId=this.store.affinity(key.id,sourceHash,provider);
    const preferred=accounts.find(a=>a.id===preferredId);
    const candidates = accounts.filter(a => a.enabled && a.authStatus !== 'login_required' && !this.suspended.has(a.id) && a.cooldownUntil <= now &&
      (this.byAccount.get(a.id) || 0) < a.maxConcurrent && !this.quotaBlocked(a,now,model));
    if (!candidates.length) throw new AdmissionError(`No available ${provider} account; retry later`,503);
    const usage=a=>this.utilization(a,now,model);
    const belowThreshold=a=>usage(a)<this.stickyUsageThreshold;
    const score=a=>createHash('sha256').update(key.id+'\0'+sourceHash+'\0'+a.id).digest().readUInt32BE(0);
    const pressure=a=>usage(a)/100+(this.byAccount.get(a.id)||0)/a.maxConcurrent;
    candidates.sort((a,b)=>Number(belowThreshold(b))-Number(belowThreshold(a)) || pressure(a)-pressure(b) || score(b)-score(a));
    const availablePreferred=candidates.find(a=>a.id===preferredId);
    // Prefer staying put. 95% is a rotation target, not a second hard quota cap:
    // if nobody below the threshold is available, existing quota remains usable.
    const healthy=candidates.find(belowThreshold);
    const account=availablePreferred && (belowThreshold(availablePreferred) || !healthy) ? availablePreferred : candidates[0];
    const permanent=!preferred || !preferred.enabled || preferred.authStatus==='login_required' ||
      (usage(preferred)>=this.stickyUsageThreshold && belowThreshold(account));
    // Busy slots, cooldowns, stale cloud data and reconnects use a temporary fallback.
    this.store.rememberAffinity(key.id,sourceHash,provider,permanent ? account.id : preferred.id);
    this.active++;
    this.byKey.set(key.id,(this.byKey.get(key.id)||0)+1);
    this.byAccount.set(account.id,(this.byAccount.get(account.id)||0)+1);
    let released = false;
    return { account, release: () => {
      if (released) return; released = true; this.active--;
      for (const [map,id] of [[this.byKey,key.id],[this.byAccount,account.id]]) {
        const n = map.get(id)-1; if (n) map.set(id,n); else map.delete(id);
      }
    } };
  }
  response(account, status, headers) {
    if (status !== 429 && status !== 401 && status !== 403) return;
    let delay = 60000;
    const retry = headers['retry-after'];
    if (retry) {
      const seconds = Number(retry);
      const parsed = Number.isFinite(seconds) ? seconds*1000 : Date.parse(retry)-Date.now();
      if (Number.isFinite(parsed) && parsed > 0) delay = Math.min(parsed,7*86400000);
    }
    this.store.cooldown(account.id,Date.now()+delay);
  }
  status() { return { stickyUsageThreshold:this.stickyUsageThreshold, affinityScope:'api_key+source_ip+provider', active: this.active, limit: this.limit, accepting: this.accepting,
    byKey: Object.fromEntries(this.byKey), byAccount: Object.fromEntries(this.byAccount) }; }
}
module.exports = { Pool, AdmissionError };
