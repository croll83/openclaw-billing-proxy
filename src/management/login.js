const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { integer } = require('./store');

function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
const terminal = new Set(['complete','failed','cancelled','expired']);
function loginEnvironment(directory) {
  // Do not inherit the host session's API keys, OAuth overrides or CLI settings.
  const env = {};
  for (const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy','NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, CLAUDE_CONFIG_DIR:directory, BROWSER:'/bin/true', DISABLE_AUTOUPDATER:'1' };
}
class LoginManager {
  constructor(store, pool, monitor, { directory, command = 'claude', spawnProcess = spawn, timeoutMs = 600000 } = {}) {
    this.store=store; this.pool=pool; this.monitor=monitor;
    this.directory=path.resolve(directory || 'data/accounts'); this.command=command;
    this.spawnProcess=spawnProcess; this.timeoutMs=timeoutMs; this.sessions=new Map(); this.closed=false;
  }
  public(session) {
    return { id:session.id, accountId:session.accountId || null, name:session.name,
      status:session.status, expiresAt:session.expiresAt, authorizationUrl:session.authorizationUrl || null,
      message:session.message || null };
  }
  get(id) { const s=this.sessions.get(id); if (!s) throw error('Login session not found',404); return s; }
  list() { return [...this.sessions.values()].filter(s=>!terminal.has(s.status)).map(s=>this.public(s)); }
  locked(id) { return [...this.sessions.values()].some(s=>s.accountId===id && !terminal.has(s.status)); }
  start(input = {}, accountId) {
    if (this.closed) throw error('Proxy is shutting down',503);
    for (const [id,s] of this.sessions) if (terminal.has(s.status) && s.expiresAt < Date.now()) this.sessions.delete(id);
    if (this.list().length >= 4 || this.sessions.size >= 32) throw error('Too many login attempts; wait for existing sessions to expire',429);
    const old=accountId ? this.store.accounts().find(a=>a.id===accountId) : null;
    if (accountId && !old) throw error('Account not found',404);
    if ((old?.provider || input.provider || 'anthropic') !== 'anthropic') throw error('Guided login currently supports Anthropic; register a Gemini credential file instead');
    if (accountId && (this.locked(accountId) || this.pool.byAccount.get(accountId))) throw error('Wait for active requests or an existing login before reconnecting',409);
    const name=old?.name || input.name;
    if (typeof name !== 'string' || !name.trim() || name.length>120) throw error('Name must contain 1–120 characters');
    const maxConcurrent=integer(old?.maxConcurrent ?? input.maxConcurrent,2);
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const directory=fs.mkdtempSync(path.join(this.directory,'claude-')); fs.chmodSync(directory,0o700);
    const s={id:randomUUID(),accountId,name:name.trim(),maxConcurrent,old,directory,
      credentialsPath:path.join(directory,'.credentials.json'),status:'starting',expiresAt:Date.now()+this.timeoutMs,buffer:'',bytes:0};
    this.sessions.set(s.id,s);
    if (accountId) { this.pool.suspended.add(accountId); this.monitor.suspended.add(accountId); }
    s.timer=setTimeout(()=>this.stop(s,'expired','Login expired. Start a new connection.'),this.timeoutMs); s.timer.unref();
    try {
      const child=this.spawnProcess(this.command,['auth','login','--claudeai'],{
        cwd:directory, env:loginEnvironment(directory), stdio:['pipe','pipe','pipe'], shell:false,
      });
      s.child=child;
      s.exited=new Promise(resolve=>child.once('close',resolve));
      child.stdout.on('data',chunk=>this.output(s,chunk)); child.stderr.on('data',chunk=>this.output(s,chunk));
      child.stdin.on('error',()=>{});
      child.once('error',()=>this.stop(s,'failed','Unable to start Claude Code. Check the configured CLI executable.'));
      child.once('close',code=>{
        s.child=null;
        if (s.stopping) return;
        s.authorizationUrl=null; s.buffer='';
        if (code !== 0) { this.stop(s,'failed','Login did not complete. Start again and use the code from the new link.'); return; }
        this.verify(s).catch(()=>this.stop(s,'failed','Unable to save the connected account.'));
      });
    } catch (_) { this.stop(s,'failed','Unable to start Claude Code. Check the configured CLI executable.'); }
    return this.public(s);
  }
  output(s,chunk) {
    if (s.stopping || terminal.has(s.status) || s.codeSubmitted) return;
    s.bytes+=chunk.length;
    if (s.bytes>65536) { this.stop(s,'failed','Unexpected CLI output. Check Claude Code compatibility.'); return; }
    s.buffer=(s.buffer+chunk.toString('utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-16384);
    // Only complete, allowlisted provider authorization links are exposed. Raw CLI output is never returned/logged.
    for (const match of s.buffer.matchAll(/https:\/\/[^\s<>"']+(?=\s)/g)) {
      try {
        const url=new URL(match[0]);
        if (url.username || url.password || url.port) continue;
        if (![['claude.com','/cai/oauth/authorize'],['claude.ai','/oauth/authorize']].some(([host,p])=>url.hostname===host && url.pathname===p)) continue;
        if (!url.searchParams.get('state') || !url.searchParams.get('code_challenge')) continue;
        s.authorizationUrl=url.href; s.status='awaiting_login';
      } catch (_) {}
    }
    if (s.authorizationUrl) s.buffer='';
  }
  submit(id,code) {
    const s=this.get(id);
    if (s.status !== 'awaiting_login' || !s.child || s.codeSubmitted) throw error('This login is not waiting for a code',409);
    if (typeof code !== 'string' || !code.trim() || code.length>4096 || /[\s\x00-\x1f\x7f]/.test(code.trim())) throw error('Paste only the authorization code');
    s.codeSubmitted=true; s.status='authorizing'; s.authorizationUrl=null;
    s.child.stdin.write(code.trim()+'\n');
    return this.public(s);
  }
  async verify(s) {
    if (s.stopping || terminal.has(s.status) || s.status==='verifying') return;
    s.status='verifying'; s.message=null;
    s.verification=(async()=>{
      try {
        const stat=fs.lstatSync(s.credentialsPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size>1024*1024) throw error('Invalid credential file');
        const oauth=JSON.parse(fs.readFileSync(s.credentialsPath,'utf8')).claudeAiOauth;
        if (!oauth?.accessToken || !oauth.refreshToken) throw error('Renewable credentials missing');
        fs.chmodSync(s.credentialsPath,0o600);
      } catch (_) { await this.stop(s,'failed','Claude Code did not save valid renewable credentials. Start a new login.'); return; }
      try {
        // Wait out a refresh already using the previous profile before replacing its reference.
        if (s.accountId) await this.monitor.pending.get(s.accountId);
        const quota=await this.monitor.read({id:s.id,provider:'anthropic',credentialsPath:s.credentialsPath});
        if (s.stopping || this.closed) return;
        if (s.accountId && !this.store.accounts().some(a=>a.id===s.accountId && a.credentialsPath===s.old.credentialsPath)) throw error('Account changed during login');
        this.store.db.exec('BEGIN IMMEDIATE');
        let account;
        try {
          account=this.store.saveAccount({name:s.name,provider:'anthropic',maxConcurrent:s.maxConcurrent,
            credentialsPath:s.credentialsPath,enabled:s.old ? s.old.enabled : true},s.accountId);
          this.store.quota(account.id,quota); this.store.authStatus(account.id,'ok');
          this.store.db.exec('COMMIT');
        } catch (err) { this.store.db.exec('ROLLBACK'); throw err; }
        s.accountId=account.id;
        this.monitor.lastAttempt.delete(account.id); this.monitor.retryAt.delete(account.id);
        s.status='complete'; s.message='Account connected. Cloud usage verified.'; s.keep=true;
        this.release(s);
      } catch (err) {
        if (s.stopping) return;
        if (err.code==='LOGIN_REQUIRED') { await this.stop(s,'failed','Login rejected. Start a new connection.'); return; }
        s.status='verification_failed'; s.message='Login saved, but cloud usage could not be verified. Retry verification; the pool has not been changed.';
      }
    })();
    await s.verification;
  }
  retry(id) {
    const s=this.get(id);
    if (s.status!=='verification_failed') throw error('This login is not waiting for verification',409);
    if ((this.monitor.retryAt.get(s.id)||0)>Date.now()) throw error('Provider requested a pause; retry verification later',429);
    this.verify(s).catch(()=>this.stop(s,'failed','Unable to verify the account.'));
    return this.public(s);
  }
  release(s) {
    clearTimeout(s.timer); s.authorizationUrl=null; s.buffer='';
    if (s.old) { this.pool.suspended.delete(s.old.id); this.monitor.suspended.delete(s.old.id); }
  }
  async stop(s,status='cancelled',message='Login cancelled. Existing credentials are unchanged.') {
    if (terminal.has(s.status) || s.stopping) return s.stopping;
    s.status=status; s.message=message; s.authorizationUrl=null;
    s.stopping=(async()=>{
      if (s.child) {
        const child=s.child; child.kill('SIGTERM');
        const kill=setTimeout(()=>child.kill('SIGKILL'),2000); kill.unref();
        await s.exited; clearTimeout(kill);
      }
      // Staged profiles are never referenced by the pool before verification commits.
      this.release(s);
      if (!s.keep) fs.rmSync(s.directory,{recursive:true,force:true});
    })();
    await s.stopping;
  }
  async close() {
    this.closed=true;
    await Promise.all([...this.sessions.values()].map(s=>this.stop(s)));
    await Promise.allSettled([...this.sessions.values()].map(s=>s.verification));
  }
}
module.exports={LoginManager,loginEnvironment};
