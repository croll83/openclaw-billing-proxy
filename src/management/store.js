const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { BlockList, isIP } = require('node:net');

const hash = value => createHash('sha256').update(value).digest('hex');
function bad(message) { const e = new Error(message); e.status = 400; throw e; }
function integer(value, fallback, max = 10000) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) bad(`Expected an integer between 1 and ${max}`);
  return n;
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) bad('Name must contain 1–120 characters');
  return value.trim();
}
function ipList(values = []) {
  if (!Array.isArray(values) || values.length > 100) bad('Invalid source IP list');
  const rules = new BlockList();
  for (const value of values) {
    if (typeof value !== 'string') bad('Invalid source IP rule');
    const parts = value.split('/');
    const version = isIP(parts[0]);
    if (!version || parts.length > 2) bad('Use an IP address or CIDR subnet');
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (parts.length === 1) rules.addAddress(parts[0], family);
    else {
      if (!/^\d+$/.test(parts[1])) bad('Invalid CIDR prefix');
      const prefix = Number(parts[1]);
      if (prefix > (version === 4 ? 32 : 128)) bad('Invalid CIDR prefix');
      rules.addSubnet(parts[0], prefix, family);
    }
  }
  return rules;
}
function allowsIP(rules, address) {
  if (!rules.length) return true;
  const normalized = (address || '').replace(/^::ffff:/, '');
  const version = isIP(normalized);
  return !!version && ipList(rules).check(normalized, version === 4 ? 'ipv4' : 'ipv6');
}
function publicKey(row) {
  if (!row) return null;
  const { digest, ...rest } = row;
  return { ...rest, enabled: !!rest.enabled, providers: JSON.parse(rest.providers), sourceIps: JSON.parse(rest.sourceIps) };
}
function publicAccount(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled, quota: row.quota ? JSON.parse(row.quota) : null };
}
class Store {
  constructor(filename) {
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(filename, 'a', 0o600); fs.closeSync(fd); fs.chmodSync(filename, 0o600);
    }
    this.db = new DatabaseSync(filename);
    // DELETE journal inherits database permissions; avoid accidentally world-readable WAL files.
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, app TEXT NOT NULL, prefix TEXT NOT NULL,
        digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, providers TEXT NOT NULL,
        sourceIps TEXT NOT NULL, maxConcurrent INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, project TEXT, credentialsPath TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL, maxConcurrent INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        quota TEXT, quotaUpdatedAt INTEGER, quotaError TEXT, cooldownUntil INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, keyId TEXT, accountId TEXT, provider TEXT, model TEXT,
        startedAt INTEGER NOT NULL, finishedAt INTEGER, status INTEGER, outcome TEXT);
      CREATE INDEX IF NOT EXISTS requests_time ON requests(startedAt);
      CREATE INDEX IF NOT EXISTS requests_account ON requests(accountId, startedAt);
      CREATE TABLE IF NOT EXISTS quota_samples (id INTEGER PRIMARY KEY, accountId TEXT NOT NULL, at INTEGER NOT NULL, quota TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS quota_samples_account_time ON quota_samples(accountId,at);
      CREATE TABLE IF NOT EXISTS account_affinity (
        keyId TEXT NOT NULL, sourceHash TEXT NOT NULL, provider TEXT NOT NULL,
        accountId TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(keyId,sourceHash,provider));
      CREATE INDEX IF NOT EXISTS affinity_account ON account_affinity(accountId);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, entityId TEXT);
    `);
    if (!this.db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'authStatus')) {
      this.db.exec("ALTER TABLE accounts ADD COLUMN authStatus TEXT NOT NULL DEFAULT 'unknown'");
    }
    this.db.prepare("UPDATE requests SET finishedAt=?, outcome='interrupted_restart' WHERE finishedAt IS NULL").run(Date.now());
  }
  audit(action, id) { this.db.prepare('INSERT INTO audit(at,action,entityId) VALUES(?,?,?)').run(Date.now(), action, id); }
  keys() { return this.db.prepare('SELECT * FROM api_keys ORDER BY createdAt').all().map(publicKey); }
  saveKey(input, id) {
    const old = id ? this.keys().find(k => k.id === id) : null;
    if (id && !old) { const e = new Error('API key not found'); e.status = 404; throw e; }
    const item = { ...old, ...input };
    const name = label(item.name), app = label(item.app || name);
    const providers = item.providers ?? ['anthropic', 'gemini'];
    if (!Array.isArray(providers) || !providers.length || providers.some(p => !['anthropic', 'gemini'].includes(p))) bad('Invalid API/provider permissions');
    const sourceIps = item.sourceIps ?? []; ipList(sourceIps);
    const maxConcurrent = integer(item.maxConcurrent, 4);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') bad('enabled must be boolean');
    let secret;
    if (!id) {
      id = randomUUID(); secret = 'hbp_' + randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,app,secret.slice(0,12),hash(secret),item.enabled === false ? 0 : 1,JSON.stringify(providers),JSON.stringify(sourceIps),maxConcurrent,Date.now());
    } else this.db.prepare('UPDATE api_keys SET name=?,app=?,enabled=?,providers=?,sourceIps=?,maxConcurrent=? WHERE id=?').run(name,app,item.enabled === false ? 0 : 1,JSON.stringify(providers),JSON.stringify(sourceIps),maxConcurrent,id);
    this.audit(old ? 'key.update' : 'key.create', id);
    return { key: this.keys().find(k => k.id === id), ...(secret ? { secret } : {}) };
  }
  rotateKey(id) {
    if (!this.keys().some(k => k.id === id)) { const e = new Error('API key not found'); e.status = 404; throw e; }
    const secret = 'hbp_' + randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE api_keys SET digest=?,prefix=? WHERE id=?').run(hash(secret),secret.slice(0,12),id);
    this.audit('key.rotate',id); return { secret };
  }
  authenticate(secret, address) {
    if (typeof secret !== 'string' || secret.length > 256) return null;
    const key = publicKey(this.db.prepare('SELECT * FROM api_keys WHERE digest=? AND enabled=1').get(hash(secret)));
    return key && allowsIP(key.sourceIps,address) ? key : null;
  }
  accounts() { return this.db.prepare('SELECT * FROM accounts ORDER BY createdAt').all().map(publicAccount); }
  saveAccount(input, id) {
    const old = id ? this.accounts().find(a => a.id === id) : null;
    if (id && !old) { const e = new Error('Account not found'); e.status = 404; throw e; }
    const item = { ...old, ...input };
    const name = label(item.name), maxConcurrent = integer(item.maxConcurrent, 2);
    const provider = item.provider ?? 'anthropic';
    if (!['anthropic','gemini'].includes(provider)) bad('Invalid provider');
    const project = provider === 'gemini' ? label(item.project) : null;
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') bad('enabled must be boolean');
    if (typeof item.credentialsPath !== 'string' || !path.isAbsolute(item.credentialsPath)) bad('Use an absolute credentials file path on the proxy host');
    let canonical;
    try {
      canonical = fs.realpathSync(item.credentialsPath);
      const stat = fs.statSync(canonical);
      if (!stat.isFile() || stat.size > 1024 * 1024) bad('Invalid credentials file');
      const creds = JSON.parse(fs.readFileSync(canonical,'utf8').replace(/^\uFEFF/,''));
      if (provider === 'anthropic' ? !creds.claudeAiOauth?.accessToken : !creds.access_token) bad('File does not contain provider OAuth credentials');
    } catch (_) { bad('Cannot read a valid provider credentials file'); }
    if (this.accounts().some(a => a.id !== id && a.credentialsPath === canonical)) bad('Credentials already registered');
    if (!id) {
      id = randomUUID();
      this.db.prepare('INSERT INTO accounts(id,name,provider,project,credentialsPath,enabled,maxConcurrent,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(id,name,provider,project,canonical,item.enabled === false ? 0 : 1,maxConcurrent,Date.now());
    } else this.db.prepare('UPDATE accounts SET name=?,provider=?,project=?,credentialsPath=?,enabled=?,maxConcurrent=?,quota=NULL,quotaUpdatedAt=NULL,quotaError=NULL,cooldownUntil=0 WHERE id=?').run(name,provider,project,canonical,item.enabled === false ? 0 : 1,maxConcurrent,id);
    this.audit(old ? 'account.update' : 'account.create',id); return this.accounts().find(a => a.id === id);
  }
  remove(kind,id) {
    if (!['accounts','api_keys'].includes(kind)) bad('Invalid entity');
    const result = this.db.prepare(`DELETE FROM ${kind} WHERE id=?`).run(id);
    if (!result.changes) { const e = new Error('Not found'); e.status = 404; throw e; }
    this.db.prepare(`DELETE FROM account_affinity WHERE ${kind === 'api_keys' ? 'keyId' : 'accountId'}=?`).run(id);
    this.audit(kind+'.delete',id);
  }
  quota(id, value, error = null) {
    if (error) this.db.prepare('UPDATE accounts SET quotaError=? WHERE id=?').run(error,id);
    else {
      const at=Date.now(),serialized=JSON.stringify(value);
      this.db.exec('SAVEPOINT quota_write');
      try {
        const result=this.db.prepare('UPDATE accounts SET quota=?,quotaUpdatedAt=?,quotaError=NULL WHERE id=?').run(serialized,at,id);
        if(result.changes)this.db.prepare('INSERT INTO quota_samples(accountId,at,quota) VALUES(?,?,?)').run(id,at,serialized);
        this.db.exec('RELEASE quota_write');
      } catch(error) { this.db.exec('ROLLBACK TO quota_write; RELEASE quota_write'); throw error; }
    }
  }
  affinity(keyId, sourceHash, provider) {
    return this.db.prepare('SELECT accountId FROM account_affinity WHERE keyId=? AND sourceHash=? AND provider=? AND updatedAt>=?')
      .get(keyId,sourceHash,provider,Date.now()-30*86400000)?.accountId;
  }
  rememberAffinity(keyId, sourceHash, provider, accountId) {
    this.db.prepare(`INSERT INTO account_affinity VALUES(?,?,?,?,?)
      ON CONFLICT(keyId,sourceHash,provider) DO UPDATE SET accountId=excluded.accountId,updatedAt=excluded.updatedAt`)
      .run(keyId,sourceHash,provider,accountId,Date.now());
  }
  cooldown(id, until) { this.db.prepare('UPDATE accounts SET cooldownUntil=MAX(cooldownUntil,?) WHERE id=?').run(until,id); }
  authStatus(id, status) { this.db.prepare('UPDATE accounts SET authStatus=? WHERE id=?').run(status,id); }
  begin({keyId,accountId,provider,model}) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO requests(id,keyId,accountId,provider,model,startedAt) VALUES(?,?,?,?,?,?)').run(id,keyId ?? null,accountId ?? null,provider,model,Date.now()); return id;
  }
  finish(id,status,outcome) {
    this.db.prepare('UPDATE requests SET finishedAt=?,status=?,outcome=? WHERE id=? AND finishedAt IS NULL').run(Date.now(),status,outcome,id);
  }
  report(hours) {
    return this.db.prepare(`SELECT keyId,accountId,provider,COUNT(*) requests,
      SUM(CASE WHEN outcome='completed' AND status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN outcome='disconnected' THEN 1 ELSE 0 END) disconnected,
      AVG(finishedAt-startedAt) averageDurationMs
      FROM requests WHERE startedAt>=? GROUP BY keyId,accountId,provider`).all(Date.now()-hours*3600000);
  }
  quotaHistory(id) {
    return this.db.prepare('SELECT at,quota FROM quota_samples WHERE accountId=? AND at>=? ORDER BY at DESC LIMIT 1000').all(id,Date.now()-7*86400000).map(r=>({...r,quota:JSON.parse(r.quota)}));
  }
  prune() {
    const cutoff=Date.now()-30*86400000;
    this.db.prepare('DELETE FROM requests WHERE finishedAt IS NOT NULL AND startedAt<?').run(cutoff);
    this.db.prepare('DELETE FROM quota_samples WHERE at<?').run(cutoff);
    this.db.prepare('DELETE FROM audit WHERE at<?').run(cutoff);
    this.db.prepare('DELETE FROM account_affinity WHERE updatedAt<?').run(cutoff);
  }
  close() { this.db.close(); }
}
module.exports = { Store, allowsIP, ipList, integer, hash };
