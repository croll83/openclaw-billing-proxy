const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, allowsIP } = require('../src/management/store');
const { Pool } = require('../src/management/pool');
const { QuotaMonitor } = require('../src/management/quota');
const { createManagedServers } = require('../src/management/server');
const { config } = require('./helpers');
function fixture(t, autoCleanup = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hbp-managed-'));
  const store = new Store(path.join(dir,'state.sqlite'));
  const cleanup = () => { try { store.close(); } catch (_) {} fs.rmSync(dir,{recursive:true,force:true}); };
  if (autoCleanup) t.after(cleanup);
  let index = 0;
  const account = (provider='anthropic',extra={}) => {
    const file = path.join(dir,`creds-${index++}.json`);
    fs.writeFileSync(file,JSON.stringify(provider === 'anthropic' ? {claudeAiOauth:{accessToken:'fixture-token'}} : {access_token:'fixture-token'}));
    return store.saveAccount({provider,name:provider,project:provider==='gemini'?'fixture-project':undefined,credentialsPath:file,...extra});
  };
  return {store,account,dir,cleanup};
}
function quota(store,id,utilization=10) {
  store.quota(id,{five_hour:{utilization,resets_at:new Date(Date.now()+3600000).toISOString()},seven_day:{utilization,resets_at:new Date(Date.now()+86400000).toISOString()}});
}

test('API key secrets are hashed, rotated, scoped, and revoked; source IP ignores forwarded identities',t => {
  const {store,dir}=fixture(t);
  const {key,secret}=store.saveKey({name:'agent',app:'tests',providers:['anthropic'],sourceIps:['100.64.0.0/10'],maxConcurrent:3});
  assert.equal(store.authenticate(secret,'100.116.1.2').id,key.id);
  assert.equal(store.authenticate(secret,'192.168.1.1'),null);
  assert.equal(store.authenticate('wrong','100.116.1.2'),null);
  assert.equal(JSON.stringify(store.keys()).includes(secret),false);
  assert.equal(fs.readFileSync(path.join(dir,'state.sqlite')).includes(Buffer.from(secret)),false);
  assert.equal(fs.statSync(path.join(dir,'state.sqlite')).mode & 0o777,0o600);
  const replacement=store.rotateKey(key.id).secret;
  assert.equal(store.authenticate(secret,'100.116.1.2'),null);
  assert.ok(store.authenticate(replacement,'100.116.1.2'));
  store.saveKey({enabled:false},key.id);
  assert.equal(store.authenticate(replacement,'100.116.1.2'),null);
  store.remove('api_keys',key.id);
  assert.equal(store.keys().length,0);
  assert.throws(()=>store.saveKey({name:'bad',sourceIps:['10.0.0.0/99']}));
  assert.equal(allowsIP(['127.0.0.1'],'::ffff:127.0.0.1'),true);
  assert.equal(allowsIP(['2001:db8::/32'],'2001:db8::1'),true);
});

test('pool isolates providers and gates on cloud quota, capacity and cooldown',t => {
  const {store,account}=fixture(t),a=account(),b=account('gemini');
  const key=store.saveKey({name:'test',maxConcurrent:2}).key;
  const pool=new Pool(store,{maxConcurrent:2});
  assert.throws(()=>pool.acquire(key,'anthropic'),/No available/);
  quota(store,a.id);
  const one=pool.acquire(key,'anthropic'),two=pool.acquire(key,'gemini');
  assert.equal(one.account.id,a.id);assert.equal(two.account.id,b.id);
  assert.throws(()=>pool.acquire(key,'anthropic'),/concurrency/);
  one.release();one.release();assert.equal(pool.active,1);two.release();assert.equal(pool.active,0);
  quota(store,a.id,100);assert.throws(()=>pool.acquire(key,'anthropic'),/No available/);
  quota(store,a.id);
  store.db.prepare('UPDATE accounts SET quotaUpdatedAt=? WHERE id=?').run(Date.now()-400000,a.id);
  assert.throws(()=>pool.acquire(key,'anthropic'),/No available/);
  quota(store,a.id);pool.response(a,429,{'retry-after':'120'});
  assert.ok(store.accounts().find(x=>x.id===a.id).cooldownUntil>Date.now()+110000);
  assert.throws(()=>pool.acquire(key,'anthropic'),/No available/);
  const gem=pool.acquire(key,'gemini');gem.release();
});

test('pool affinity, lower utilization selection and caller/account limits',t => {
  const {store,account}=fixture(t),a=account('anthropic',{maxConcurrent:1}),b=account('anthropic',{maxConcurrent:1});
  quota(store,a.id,80);quota(store,b.id,20);
  const key=store.saveKey({name:'test',maxConcurrent:1}).key,pool=new Pool(store);
  const one=pool.acquire(key,'anthropic');assert.equal(one.account.id,b.id);
  assert.throws(()=>pool.acquire(key,'anthropic'),/Caller concurrency/);one.release();
  const affinity=pool.acquire(key,'anthropic','session-1'),chosen=affinity.account.id;affinity.release();
  const repeat=pool.acquire(key,'anthropic','session-1');assert.equal(repeat.account.id,chosen);repeat.release();
  assert.throws(()=>store.saveAccount({name:'duplicate',credentialsPath:a.credentialsPath}),/already registered/);
});

test('quota monitor reads cloud values without derivation and keeps errors separate from last good reading',async t => {
  const {store,account}=fixture(t),a=account();let calls=0,fail=false;
  const monitor=new QuotaMonitor(store,{tokenReader:async()=>({accessToken:'fixture'}),fetcher:async(url,options)=>{
    calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(options.headers.authorization,'Bearer fixture');
    return fail?new Response('private provider response',{status:429}):new Response(JSON.stringify({five_hour:{utilization:42.7,resets_at:'2026-11-01T00:00:00Z'},seven_day:{utilization:14.2},ignored:'private'}));
  }});
  await Promise.all([monitor.refresh(a),monitor.refresh(a)]);assert.equal(calls,1);
  assert.equal(store.accounts()[0].quota.five_hour.utilization,42.7);
  assert.equal(store.accounts()[0].quota.ignored,undefined);
  fail=true;monitor.lastAttempt.clear();await monitor.refresh(a);
  assert.equal(store.accounts()[0].quota.five_hour.utilization,42.7);
  assert.equal(store.accounts()[0].quotaError,'Usage endpoint HTTP 429');
  await monitor.close();
});

async function servers(t,extra={}) {
  const f=fixture(t,false);
  const managed=createManagedServers({...config(),port:0,bindAddress:'127.0.0.1',anthropicTimeoutMs:3600000,management:{enabled:true,port:0,maxConcurrent:2,...extra.options}},
    {store:f.store,quotaOptions:{tokenReader:async()=>{throw new Error('no live credentials');}},...extra.handlers});
  await managed.start();t.after(async()=>{await managed.close({force:true});f.cleanup();});
  return {...f,managed,api:`http://127.0.0.1:${managed.inference.address().port}`,admin:`http://127.0.0.1:${managed.admin.address().port}`};
}

test('management CRUD and inference listeners remain separate; CSRF and provider scope enforced',async t => {
  const seen=[];
  const handler=(body,req,res,cfg)=>{seen.push({path:cfg.credsPath,project:cfg.GEMINI_PROJECT,headers:req.headers});res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');};
  const f=await servers(t,{handlers:{anthropic:handler,gemini:handler}});
  const a=f.account(),g=f.account('gemini');quota(f.store,a.id);
  const send=(base,url,method='GET',body,headers={})=>fetch(base+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await send(f.admin,'/admin/keys','POST',{name:'x'})).status,403);
  assert.equal((await send(f.admin,'/admin/keys','POST',{name:'x'},{'x-proxy-admin':'1',origin:'https://untrusted.invalid'})).status,403);
  const created=await send(f.admin,'/admin/keys','POST',{name:'worker',providers:['anthropic']},{'x-proxy-admin':'1'});assert.equal(created.status,201);const {key,secret}=await created.json();
  assert.equal((await send(f.api,'/v1/messages','POST',{model:'claude-opus-5-5'})).status,401);
  const headers={'x-api-key':secret};
  assert.equal((await send(f.api,'/v1/messages','POST',{model:'gemini-2.5-pro'},headers)).status,403);
  assert.equal((await send(f.api,'/v1/messages','POST',{model:'claude-opus-5-5'},headers)).status,200);
  assert.equal(seen[0].path,a.credentialsPath);assert.equal(seen[0].headers['x-api-key'],undefined);
  assert.equal((await send(f.api,'/admin/status','GET',null,headers)).status,405);
  await send(f.admin,'/admin/keys/'+key.id,'PATCH',{providers:['gemini']},{'x-proxy-admin':'1'});
  assert.equal((await send(f.api,'/v1/chat/completions','POST',{model:'gemini-2.5-pro'},headers)).status,200);
  assert.equal(seen[1].path,g.credentialsPath);assert.equal(seen[1].project,'fixture-project');
  const status=await (await send(f.admin,'/admin/status')).json();assert.equal(status.pool.active,0);assert.equal(status.last5Hours.length,2);
  assert.equal(JSON.stringify(status).includes(secret),false);
  assert.equal((await send(f.admin,'/')).status,200);
});

test('managed stream releases admission slot after disconnect without buffering',async t => {
  let closed=false;
  const f=await servers(t,{handlers:{anthropic:(body,req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');res.once('close',()=>{closed=true;});
  }}});
  const a=f.account();quota(f.store,a.id);const {secret}=f.store.saveKey({name:'stream',maxConcurrent:1});
  const response=await fetch(f.api+'/v1/messages',{method:'POST',headers:{'x-api-key':secret,'content-type':'application/json'},body:JSON.stringify({model:'claude-opus-5-5',stream:true})});
  const reader=response.body.getReader();assert.equal(Buffer.from((await reader.read()).value).toString(),'data: first\n\n');
  assert.equal(f.managed.pool.active,1);
  const blocked=await fetch(f.api+'/v1/messages',{method:'POST',headers:{'x-api-key':secret},body:JSON.stringify({model:'claude-opus-5-5'})});assert.equal(blocked.status,429);
  await reader.cancel();
  for(let i=0;i<40&&!closed;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(closed,true);assert.equal(f.managed.pool.active,0);
  assert.equal(f.store.report(5)[0].disconnected,1);
});

test('oversized input is rejected before allocating an account',async t => {
  const f=await servers(t,{options:{maxBodyBytes:32}}),{secret}=f.store.saveKey({name:'test'});
  const r=await fetch(f.api+'/v1/messages',{method:'POST',headers:{'x-api-key':secret},body:'x'.repeat(100)});
  assert.equal(r.status,413);assert.equal(f.managed.pool.active,0);
});

test('Gemini cloud quota uses its own endpoint and project, including a fully replenished bucket',async t=>{
 const {store,account}=fixture(t),a=account('gemini');
 const monitor=new QuotaMonitor(store,{geminiTokenReader:async()=> 'gemini-fixture',fetcher:async(url,options)=>{
  assert.equal(url,'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{project:'fixture-project'});
  return new Response(JSON.stringify({buckets:[{modelId:'gemini-2.5-pro',remainingFraction:1,resetTime:'2026-11-01T00:00:00Z'}]}));
 }});
 await monitor.refresh(a);const value=store.accounts()[0].quota;assert.equal(value.buckets[0].remainingFraction,1);assert.equal(value.five_hour,undefined);
 assert.equal(store.quotaHistory(a.id).length,1);await monitor.close();
});

test('model-specific Anthropic quota never spills into the Gemini pool',t=>{
 const {store,account}=fixture(t),a=account(),g=account('gemini');quota(store,a.id);
 const q=store.accounts().find(x=>x.id===a.id).quota;q.seven_day_opus={utilization:100,resets_at:new Date(Date.now()+86400000).toISOString()};store.quota(a.id,q);
 const key=store.saveKey({name:'test'}).key,pool=new Pool(store);
 assert.throws(()=>pool.acquire(key,'anthropic','','claude-opus-5-5'),/No available anthropic/);
 const sonnet=pool.acquire(key,'anthropic','','claude-sonnet-5-5');assert.equal(sonnet.account.id,a.id);sonnet.release();
 const gemini=pool.acquire(key,'gemini','','gemini-2.5-pro');assert.equal(gemini.account.id,g.id);gemini.release();
});

test('parallel callers cannot exceed global capacity and capacity recovers after completions',async t=>{
 const pending=[];
 const f=await servers(t,{handlers:{anthropic:(body,req,res)=>{pending.push(res);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ready\n\n');}}});
 const a=f.account('anthropic',{maxConcurrent:10});quota(f.store,a.id);
 const {secret}=f.store.saveKey({name:'parallel',maxConcurrent:10});
 const responses=await Promise.all(Array.from({length:12},()=>fetch(f.api+'/v1/messages',{method:'POST',headers:{'x-api-key':secret},body:JSON.stringify({model:'claude-opus-5-5',stream:true})})));
 assert.equal(responses.filter(r=>r.status===200).length,2);assert.equal(responses.filter(r=>r.status===429).length,10);assert.equal(f.managed.pool.active,2);
 for(const res of pending)res.end('data: done\n\n');await Promise.all(responses.map(r=>r.text()));
 assert.equal(f.managed.pool.active,0);
});

test('store persists cloud snapshots and flags incomplete requests on a subsequent start',t=>{
 const {store,account,dir}=fixture(t),a=account();quota(store,a.id,37);
 const id=store.begin({keyId:'fixture-key',accountId:a.id,provider:'anthropic',model:'fixture-model'});store.close();
 const reopened=new Store(path.join(dir,'state.sqlite'));
 assert.equal(reopened.accounts()[0].quota.five_hour.utilization,37);
 assert.equal(reopened.quotaHistory(a.id).length,1);
 assert.equal(reopened.db.prepare('SELECT outcome FROM requests WHERE id=?').get(id).outcome,'interrupted_restart');reopened.close();
});

test('automatic affinity stays on account, rotates at threshold and does not bounce after reset',t=>{
  const {store,account}=fixture(t),a=account(),b=account(),key=store.saveKey({name:'sticky'}).key;
  quota(store,a.id,10);quota(store,b.id,40);const pool=new Pool(store);
  const choose=()=>{const l=pool.acquire(key,'anthropic','100.64.0.1','claude-opus-5-5');l.release();return l.account.id;};
  assert.equal(choose(),a.id);quota(store,a.id,80);quota(store,b.id,5);assert.equal(choose(),a.id);
  quota(store,a.id,95);assert.equal(choose(),b.id);quota(store,a.id,0);assert.equal(choose(),b.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM account_affinity').get().n,1);
});

test('busy slots, cooldown, stale cloud and reconnect use temporary fallback without replacing affinity',t=>{
  const {store,account}=fixture(t),a=account('anthropic',{maxConcurrent:1}),b=account(),key=store.saveKey({name:'sticky',maxConcurrent:4}).key;
  quota(store,a.id,10);quota(store,b.id,40);const pool=new Pool(store);
  const acquire=()=>pool.acquire(key,'anthropic','100.64.0.1');
  const first=acquire();assert.equal(first.account.id,a.id);
  const overflow=acquire();assert.equal(overflow.account.id,b.id);overflow.release();first.release();
  for(const reason of ['cooldown','stale','reconnect']){
    if(reason==='cooldown')store.cooldown(a.id,Date.now()+60000);
    if(reason==='stale')store.db.prepare('UPDATE accounts SET quotaUpdatedAt=? WHERE id=?').run(1,a.id);
    if(reason==='reconnect')pool.suspended.add(a.id);
    const fallback=acquire();assert.equal(fallback.account.id,b.id);fallback.release();
    assert.equal(store.db.prepare('SELECT accountId FROM account_affinity').get().accountId,a.id);
    store.db.prepare('UPDATE accounts SET cooldownUntil=0 WHERE id=?').run(a.id);quota(store,a.id,10);pool.suspended.delete(a.id);
    const restored=acquire();assert.equal(restored.account.id,a.id);restored.release();
  }
  store.authStatus(a.id,'login_required');const rotated=acquire();assert.equal(rotated.account.id,b.id);rotated.release();
  store.authStatus(a.id,'ok');const stable=acquire();assert.equal(stable.account.id,b.id);stable.release();
});

test('affinity separates key, source and provider, normalizes mapped IPv4 and survives database reopening',t=>{
  const f=fixture(t),a=f.account(),b=f.account(),g=f.account('gemini');quota(f.store,a.id,5);quota(f.store,b.id,50);
  const key=f.store.saveKey({name:'one'}).key,other=f.store.saveKey({name:'two'}).key;
  let store=f.store,pool=new Pool(store);
  const choose=(k=key,ip='100.64.0.1',provider='anthropic')=>{const l=pool.acquire(k,provider,ip);l.release();return l.account.id;};
  assert.equal(choose(),a.id);quota(store,a.id,70);quota(store,b.id,10);
  assert.equal(choose(key,'::ffff:100.64.0.1'),a.id);assert.equal(choose(other),b.id);assert.equal(choose(key,'100.64.0.2'),b.id);assert.equal(choose(key,'100.64.0.1','gemini'),g.id);
  store.rotateKey(key.id);assert.equal(choose(),a.id);
  store.close();store=new Store(path.join(f.dir,'state.sqlite'));t.after(()=>store.close());pool=new Pool(store);
  assert.equal(choose(),a.id);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM account_affinity').get().n,4);
  store.remove('api_keys',key.id);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM account_affinity').get().n,1);
  store.remove('accounts',b.id);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM account_affinity').get().n,0);
});

test('95% is a soft rotation target, 100% remains unavailable and model-specific windows are respected',t=>{
  const {store,account}=fixture(t),a=account(),b=account(),key=store.saveKey({name:'sticky'}).key;
  const pool=new Pool(store);const choose=model=>{const l=pool.acquire(key,'anthropic','100.64.0.1',model);l.release();return l.account.id;};
  quota(store,a.id,10);quota(store,b.id,50);assert.equal(choose('claude-sonnet'),a.id);
  store.quota(a.id,{five_hour:{utilization:10},seven_day:{utilization:20},seven_day_opus:{utilization:95}});
  assert.equal(choose('claude-sonnet'),a.id);assert.equal(choose('claude-opus'),b.id);
  quota(store,a.id,96);quota(store,b.id,97);assert.equal(choose('claude-opus'),b.id);
  quota(store,a.id,100);quota(store,b.id,100);assert.throws(()=>choose('claude-opus'),/No available/);
  assert.equal(pool.active,0);
  quota(store,a.id,10);quota(store,b.id,50);const custom=new Pool(store,{stickyUsageThreshold:60});
  const lease=custom.acquire(key,'anthropic','100.64.0.2');assert.equal(lease.account.id,a.id);lease.release();quota(store,a.id,60);
  const next=custom.acquire(key,'anthropic','100.64.0.2');assert.equal(next.account.id,b.id);next.release();
  assert.throws(()=>new Pool(store,{stickyUsageThreshold:101}),/stickyUsageThreshold/);
});

test('Gemini sticky rotation uses matching cloud model bucket and remains in its own pool',t=>{
  const {store,account}=fixture(t),a=account('gemini'),b=account('gemini');const key=store.saveKey({name:'gemini'}).key,pool=new Pool(store);
  const set=(id,remaining)=>store.quota(id,{buckets:[{modelId:'gemini-test',remainingFraction:remaining}]});
  const choose=()=>{const l=pool.acquire(key,'gemini','100.64.0.1','google/gemini-test');l.release();return l.account.id;};
  set(a.id,.9);set(b.id,.7);assert.equal(choose(),a.id);set(a.id,.05);assert.equal(choose(),b.id);set(a.id,1);assert.equal(choose(),b.id);
});

test('HTTP automatic affinity ignores session and forwarded IP headers without requiring client changes',async t=>{
  const seen=[];const f=await servers(t,{handlers:{anthropic:(body,req,res,cfg)=>{seen.push({path:cfg.credsPath,headers:req.headers});res.end('{}');}}});
  const a=f.account(),b=f.account();quota(f.store,a.id,5);quota(f.store,b.id,50);const {secret}=f.store.saveKey({name:'sticky-http'});
  const request=headers=>fetch(f.api+'/v1/messages',{method:'POST',headers:{'x-api-key':secret,...headers},body:JSON.stringify({model:'claude-opus-5-5'})});
  assert.equal((await request({})).status,200);quota(f.store,a.id,80);quota(f.store,b.id,5);
  assert.equal((await request({'x-proxy-session':'different-session','x-forwarded-for':'203.0.113.42'})).status,200);
  assert.equal(seen[0].path,a.credentialsPath);assert.equal(seen[1].path,a.credentialsPath);assert.equal(seen[1].headers['x-proxy-session'],undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM account_affinity').get().n,1);
  quota(f.store,a.id,95);assert.equal((await request({})).status,200);assert.equal(seen[2].path,b.credentialsPath);
});
