const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { Store, integer, allowsIP } = require('./store');
const { Pool } = require('./pool');
const { QuotaMonitor } = require('./quota');
const { LoginManager } = require('./login');
const { handleAnthropicRequest } = require('../proxy/anthropic');
const { handleGeminiRequest } = require('../proxy/gemini');
const { handleGeminiNativeRequest } = require('../proxy/geminiNative');

function json(res,status,value) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...(status === 429 || status === 503 ? { 'retry-after': '5' } : {}) });
  res.end(JSON.stringify(value));
}
function readBody(req,limit) {
  return new Promise((resolve,reject) => {
    const chunks = []; let size = 0;
    req.on('data',chunk => {
      size += chunk.length;
      if (size > limit) { chunks.length = 0; const e = new Error('Request body too large'); e.status = 413; reject(e); }
      else chunks.push(chunk);
    });
    req.on('end',() => resolve(Buffer.concat(chunks).toString()));
    req.on('error',reject);
    req.on('aborted',() => reject(new Error('Client disconnected')));
  });
}
function parseBody(body) {
  try { const value = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (_) { const e = new Error('Expected a JSON object'); e.status = 400; throw e; }
}
function route(url, body) {
  const pathname = new URL(url,'http://proxy.invalid').pathname;
  if (/^\/v1(?:beta)?\/models\/gemini[^/:]+:(?:streamGenerateContent|generateContent)$/.test(pathname)) {
    return { provider: 'gemini', native: true, model: pathname.split('/models/')[1].split(':')[0] };
  }
  if (!['/v1/messages','/v1/messages/count_tokens','/v1/chat/completions'].includes(pathname)) {
    const e = new Error('Unknown inference endpoint'); e.status = 404; throw e;
  }
  if (typeof body.model !== 'string' || !body.model || body.model.length > 200) { const e = new Error('A model ID is required'); e.status = 400; throw e; }
  const provider = /^(google\/)?gemini-/.test(body.model) ? 'gemini' : 'anthropic';
  if (provider === 'anthropic' && pathname === '/v1/chat/completions') { const e = new Error('Anthropic requires /v1/messages'); e.status = 400; throw e; }
  return { provider, native: false, model: body.model };
}
function observe(res,store,id,release) {
  let finished = false;
  const finish = outcome => {
    if (finished) return; finished = true;
    try { store.finish(id,res.statusCode,outcome); }
    catch (_) { console.error('[REPORT] Failed to persist request outcome'); }
    finally { release(); }
  };
  res.once('finish',() => finish('completed'));
  res.once('close',() => finish('disconnected'));
}
function createManagedServers(config, overrides = {}) {
  const options = config.management || {};
  const adminHost = options.bindAddress || '127.0.0.1';
  if (!isIP(adminHost) || !allowsIP(['127.0.0.0/8','::1','100.64.0.0/10'],adminHost)) throw new Error('Unauthenticated console must bind to loopback or Tailscale');
  const store = overrides.store || new Store(path.resolve(options.databasePath || 'data/proxy.sqlite'));
  const pool = new Pool(store,{ maxConcurrent: integer(options.maxConcurrent,32), stickyUsageThreshold: options.stickyUsageThreshold ?? 95 });
  const monitor = new QuotaMonitor(store,{geminiConfig:config,...overrides.quotaOptions});
  const logins = new LoginManager(store,pool,monitor,{directory:options.accountsDirectory || path.join(path.dirname(path.resolve(options.databasePath || 'data/proxy.sqlite')),'accounts'),command:options.claudeCommand || 'claude',...overrides.loginOptions});
  const maxBodyBytes = integer(options.maxBodyBytes,16*1024*1024,128*1024*1024);
  const maxPending = integer(options.maxPendingBodies,64);
  let pending = 0, counter = 0;
  const startedAt = Date.now();
  const inference = http.createServer(async (req,res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') { json(res,200,{status:pool.accepting ? 'ok' : 'draining'}); return; }
      const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
      const rawKey = req.headers['x-api-key'] || bearer;
      let key = store.authenticate(rawKey,req.socket.remoteAddress);
      if (!key) { json(res,401,{error:{code:'invalid_api_key',message:'Missing, revoked or unauthorized API key'}}); req.resume(); return; }
      if (req.method !== 'POST') { json(res,405,{error:{message:'Use POST for inference'}}); req.resume(); return; }
      if (!pool.accepting || pending >= maxPending) { json(res,503,{error:{message:'Proxy admission capacity reached'}}); req.resume(); return; }
      pending++;
      let bodyStr;
      try { bodyStr = await readBody(req,maxBodyBytes); } finally { pending--; }
      if (res.destroyed) return;
      key = store.authenticate(rawKey,req.socket.remoteAddress);
      if (!key) { json(res,401,{error:{message:'API key revoked or access changed during upload'}}); return; }
      const body = parseBody(bodyStr), target = route(req.url,body);
      if (!key.providers.includes(target.provider)) { json(res,403,{error:{message:'API key does not allow this provider'}}); return; }
      const lease = pool.acquire(key,target.provider,req.socket.remoteAddress || '',target.model);
      let id;
      try { id = store.begin({keyId:key.id,accountId:lease.account.id,provider:target.provider,model:target.model}); }
      catch (error) { lease.release(); throw error; }
      observe(res,store,id,lease.release);
      // Caller authentication/affinity belongs to this proxy, never to an upstream account.
      delete req.headers.authorization; delete req.headers['x-api-key']; delete req.headers['x-proxy-session'];
      const scoped = { ...config, credsPath: lease.account.credentialsPath,
        geminiCredentialsPath: lease.account.credentialsPath, GEMINI_PROJECT: lease.account.project || config.GEMINI_PROJECT,
        onUpstreamResponse: (status,headers) => {
          try { pool.response(lease.account,status,headers); }
          catch (_) { console.error('[POOL] Failed to persist account cooldown'); }
        } };
      const handler = target.provider === 'anthropic' ? (overrides.anthropic || handleAnthropicRequest) :
        target.native ? (overrides.geminiNative || handleGeminiNativeRequest) : (overrides.gemini || handleGeminiRequest);
      await handler(bodyStr,req,res,scoped,++counter,new Date().toISOString().slice(11,19));
    } catch (error) { json(res,error.status || 500,{error:{message:error.status ? error.message : 'Proxy request failed'}}); }
  });
  inference.requestTimeout = 120000; // Receiving request bodies, not generation duration.
  inference.headersTimeout = 30000;
  const assets = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
  const admin = http.createServer(async (req,res) => {
    try {
      // Host validation blocks DNS rebinding. No CORS; custom mutation header blocks cross-site forms.
      const host = req.headers.host;
      const expectedPort = admin.address()?.port;
      const hostname = adminHost.includes(':') ? `[${adminHost}]` : adminHost;
      if (![`${hostname}:${expectedPort}`, ...(adminHost === '127.0.0.1' ? [`localhost:${expectedPort}`] : [])].includes(host)) {
        json(res,403,{error:{message:'Invalid console host'}}); return;
      }
      if (req.headers.origin && req.headers.origin !== `http://${host}`) { json(res,403,{error:{message:'Cross-origin console request denied'}}); return; }
      const url = new URL(req.url,`http://${host}`), pathname = url.pathname;
      if (req.method === 'GET' && assets[pathname]) {
        const [file,type] = assets[pathname];
        res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
        res.end(fs.readFileSync(path.join(__dirname,'../../web',file))); return;
      }
      if (pathname === '/admin/status' && req.method === 'GET') {
        json(res,200,{version:config.VERSION,uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),
          inference:inference.address(),console:admin.address(),pool:pool.status(),pendingBodies:pending,
          idleTimeoutMs:config.anthropicTimeoutMs,requests:counter,accounts:store.accounts(),keys:store.keys(),
          logins:logins.list(),last5Hours:store.report(5),last7Days:store.report(168)}); return;
      }
      const loginMatch = /^\/admin\/logins\/([a-f0-9-]+)(?:\/(code|verify))?$/.exec(pathname);
      if (req.method === 'GET' && loginMatch && !loginMatch[2]) { json(res,200,logins.public(logins.get(loginMatch[1]))); return; }
      const historyMatch = /^\/admin\/accounts\/([a-f0-9-]+)\/usage$/.exec(pathname);
      if (req.method === 'GET' && historyMatch) { json(res,200,store.quotaHistory(historyMatch[1])); return; }
      const readMatch = /^\/admin\/(keys|accounts)(?:\/([a-f0-9-]+))?$/.exec(pathname);
      if (req.method === 'GET' && readMatch) {
        const items = readMatch[1] === 'keys' ? store.keys() : store.accounts();
        const item = readMatch[2] ? items.find(x => x.id === readMatch[2]) : items;
        json(res,item ? 200 : 404,item || {error:{message:'Not found'}}); return;
      }
      if (req.headers['x-proxy-admin'] !== '1') { json(res,403,{error:{message:'Console mutation header required'}}); req.resume(); return; }
      if (req.method === 'POST' && pathname === '/admin/logins') {
        json(res,201,logins.start(parseBody(await readBody(req,32768)))); return;
      }
      const reconnect = /^\/admin\/accounts\/([a-f0-9-]+)\/reconnect$/.exec(pathname);
      if (req.method === 'POST' && reconnect) { json(res,201,logins.start({},reconnect[1])); return; }
      if (loginMatch) {
        const [,id,action]=loginMatch;
        if (req.method === 'DELETE' && !action) { const session=logins.get(id); await logins.stop(session); json(res,200,logins.public(session)); return; }
        if (req.method === 'POST' && action === 'code') { const body=parseBody(await readBody(req,8192)); json(res,200,logins.submit(id,body.code)); return; }
        if (req.method === 'POST' && action === 'verify') { json(res,200,logins.retry(id)); return; }
        json(res,405,{error:{message:'Method not allowed'}}); return;
      }
      const match = /^\/admin\/(keys|accounts)(?:\/([a-f0-9-]+))?(?:\/(rotate|refresh))?$/.exec(pathname);
      if (!match) { json(res,404,{error:{message:'Unknown console endpoint'}}); return; }
      const [,kind,id,action] = match;
      if (kind === 'accounts' && id && logins.locked(id)) { json(res,409,{error:{message:'Account is reconnecting; finish or cancel its login first'}}); return; }
      if (req.method === 'DELETE' && id && !action) {
        if (kind === 'accounts' && pool.byAccount.get(id)) { json(res,409,{error:{message:'Disable account and wait for active requests before deleting'}}); return; }
        store.remove(kind === 'keys' ? 'api_keys' : 'accounts',id); json(res,200,{ok:true}); return;
      }
      if (req.method === 'POST' && id && action === 'rotate' && kind === 'keys') { json(res,200,store.rotateKey(id)); return; }
      if (req.method === 'POST' && id && action === 'refresh' && kind === 'accounts') {
        const account = store.accounts().find(a => a.id === id);
        if (!account) { json(res,404,{error:{message:'Account not found'}}); return; }
        await monitor.refresh(account); json(res,200,{ok:true}); return;
      }
      if ((req.method === 'POST' && !id || req.method === 'PATCH' && id) && !action) {
        const body = parseBody(await readBody(req,32768));
        if (kind === 'accounts' && id && pool.byAccount.get(id) && Object.keys(body).some(k => k !== 'enabled')) {
          json(res,409,{error:{message:'Wait for active requests before editing account configuration'}}); return;
        }
        const result = kind === 'keys' ? store.saveKey(body,id) : store.saveAccount(body,id);
        if (kind === 'accounts' && result.enabled) monitor.refresh(result);
        json(res,id ? 200 : 201,result); return;
      }
      json(res,405,{error:{message:'Method not allowed'}});
    } catch (error) { json(res,error.status || 500,{error:{message:error.status ? error.message : 'Console operation failed'}}); }
  });
  admin.requestTimeout = 10000; admin.headersTimeout = 10000;
  return { inference,admin,store,pool,monitor,logins,
    async start() {
      const listen = (server,port,host) => new Promise((resolve,reject) => {
        server.once('error',reject); server.listen(port,host,() => { server.removeListener('error',reject); resolve(); });
      });
      await listen(admin,options.port ?? 18803,adminHost);
      try { await listen(inference,config.port,config.bindAddress || '127.0.0.1'); }
      catch (error) { admin.close(); throw error; }
      monitor.start(); return this;
    },
    async close({ force = false } = {}) {
      pool.accepting = false;
      await Promise.all([inference,admin].map(server => new Promise(resolve => {
        server.close(resolve); if (force) server.closeAllConnections();
      })));
      await logins.close(); await monitor.close(); store.close();
    },
  };
}
module.exports = { createManagedServers, readBody, route };
