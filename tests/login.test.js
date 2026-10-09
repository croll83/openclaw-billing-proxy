const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {Store}=require('../src/management/store');
const {Pool}=require('../src/management/pool');
const {QuotaMonitor}=require('../src/management/quota');
const {LoginManager,loginEnvironment}=require('../src/management/login');
const {createManagedServers}=require('../src/management/server');
const {config}=require('./helpers');
const cloud={five_hour:{utilization:12,resets_at:'2099-01-01T00:00:00Z'},seven_day:{utilization:34,resets_at:'2099-01-01T00:00:00Z'}};
const authorize='https://claude.com/cai/oauth/authorize?state=fixture-state&code_challenge=fixture-challenge';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await pause();}assert.fail('Condition did not become true');}
function cli(){
  const children=[];
  const spawnProcess=(command,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.input='';child.signals=[];
    child.stdin.on('data',b=>{child.input+=b.toString();});
    child.kill=signal=>{child.signals.push(signal);setImmediate(()=>child.emit('close',null));return true;};
    child.options=options;child.command=command;child.args=args;
    child.complete=()=>{fs.writeFileSync(path.join(options.cwd,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000}}));child.emit('close',0);};
    children.push(child);return child;
  };
  return {children,spawnProcess};
}
function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbp-login-test-'));
  const store=new Store(path.join(dir,'state.sqlite')),pool=new Pool(store);
  const monitor=new QuotaMonitor(store,{fetcher:async()=>new Response(JSON.stringify(cloud)),...options.quota});
  const mock=cli();const manager=new LoginManager(store,pool,monitor,{directory:path.join(dir,'profiles'),spawnProcess:mock.spawnProcess,...options.login});
  t.after(async()=>{await manager.close();await monitor.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,pool,monitor,manager,...mock};
}
function existing(f){const file=path.join(f.dir,'existing.json');fs.writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'fixture-existing'}}));const a=f.store.saveAccount({name:'Existing',credentialsPath:file});f.store.quota(a.id,cloud);return a;}

test('guided login isolates profiles, handles split authorization URLs and saves only after cloud verification',async t=>{
  const f=fixture(t);const started=f.manager.start({name:'New subscription',maxConcurrent:3}),child=f.children[0];
  assert.equal(child.command,'claude');assert.deepEqual(child.args,['auth','login','--claudeai']);assert.equal(child.options.shell,false);
  assert.equal(child.options.env.CLAUDE_CONFIG_DIR,child.options.cwd);assert.equal(fs.statSync(child.options.cwd).mode&0o777,0o700);
  assert.equal(loginEnvironment('/fixture').ANTHROPIC_API_KEY,undefined);
  child.stdout.write('Unexpected https://evil.invalid/authorize?state=x\n'+authorize.slice(0,45));
  assert.equal(f.manager.public(f.manager.get(started.id)).authorizationUrl,null);
  child.stdout.write(authorize.slice(45)+'\nPaste code here if prompted > ');
  assert.equal(f.manager.get(started.id).authorizationUrl,authorize);
  assert.throws(()=>f.manager.submit(started.id,'code\nsecond line'),/only the authorization code/);
  f.manager.submit(started.id,'fixture-code#fixture-state');assert.equal(child.input,'fixture-code#fixture-state\n');
  assert.equal(f.store.accounts().length,0);child.complete();await until(()=>f.manager.get(started.id).status==='complete');
  const a=f.store.accounts()[0];assert.equal(a.name,'New subscription');assert.equal(a.maxConcurrent,3);assert.equal(a.quota.five_hour.utilization,12);assert.equal(a.authStatus,'ok');
  assert.equal(fs.statSync(a.credentialsPath).mode&0o777,0o600);
  assert.equal(JSON.stringify(f.manager.public(f.manager.get(started.id))).includes('fixture-access'),false);
  assert.equal(JSON.stringify(f.store.accounts()).includes('fixture-refresh'),false);
  const lease=f.pool.acquire(f.store.saveKey({name:'test'}).key,'anthropic');lease.release();
});

test('reconnect gates routing, rejects busy accounts and preserves old credentials on cancellation',async t=>{
  const f=fixture(t),a=existing(f),key=f.store.saveKey({name:'test'}).key;
  const lease=f.pool.acquire(key,'anthropic');assert.throws(()=>f.manager.start({},a.id),/active requests/);lease.release();
  const s=f.manager.start({},a.id);assert.throws(()=>f.pool.acquire(key,'anthropic'),/No available/);
  assert.throws(()=>f.manager.start({},a.id),/existing login/);
  await f.manager.stop(f.manager.get(s.id));
  assert.deepEqual(f.children[0].signals,['SIGTERM']);assert.equal(fs.existsSync(f.children[0].options.cwd),false);
  assert.equal(f.store.accounts()[0].credentialsPath,a.credentialsPath);assert.equal(f.store.accounts()[0].quota.five_hour.utilization,12);
  const next=f.pool.acquire(key,'anthropic');next.release();
});

test('cloud outage preserves old registration; retry verifies without another login and retains account identity',async t=>{
  let offline=true;const f=fixture(t,{quota:{fetcher:async()=>{if(offline)throw Error('Network failure with private details');return new Response(JSON.stringify(cloud));}}});
  const a=existing(f),s=f.manager.start({},a.id);f.children[0].complete();
  await until(()=>f.manager.get(s.id).status==='verification_failed');
  assert.equal(f.store.accounts()[0].credentialsPath,a.credentialsPath);assert.equal(f.manager.public(f.manager.get(s.id)).message.includes('private details'),false);
  offline=false;f.manager.retry(s.id);await until(()=>f.manager.get(s.id).status==='complete');
  assert.equal(f.children.length,1);assert.equal(f.store.accounts()[0].id,a.id);assert.notEqual(f.store.accounts()[0].credentialsPath,a.credentialsPath);
  assert.equal(fs.existsSync(a.credentialsPath),true);assert.equal(f.pool.suspended.has(a.id),false);
});

test('expired, failed and cancelled logins never register accounts or leave staged credentials',async t=>{
  const f=fixture(t,{login:{timeoutMs:30}});
  const s=f.manager.start({name:'Expires'});await until(()=>f.manager.get(s.id).status==='expired');await until(()=>!fs.existsSync(f.children[0].options.cwd));
  assert.equal(f.store.accounts().length,0);assert.throws(()=>f.manager.submit(s.id,'fixture-code'),/not waiting/);
  const fail=f.manager.start({name:'Missing executable'});f.children[1].emit('error',Error('ENOENT private path'));await until(()=>!fs.existsSync(f.children[1].options.cwd));
  assert.equal(f.manager.get(fail.id).status,'failed');assert.equal(f.manager.public(f.manager.get(fail.id)).message.includes('private path'),false);
});

test('cancellation during verification cannot publish an account',async t=>{
  let respond;const f=fixture(t,{quota:{fetcher:()=>new Promise(resolve=>{respond=resolve;})}});
  const s=f.manager.start({name:'Cancelled'});f.children[0].complete();await until(()=>respond);
  await f.manager.stop(f.manager.get(s.id));respond(new Response(JSON.stringify(cloud)));
  await f.manager.get(s.id).verification;assert.equal(f.store.accounts().length,0);assert.equal(f.manager.get(s.id).status,'cancelled');
});

test('registration is transactional if storing the verified quota fails',async t=>{
  const f=fixture(t),a=existing(f);const save=f.store.quota.bind(f.store);
  f.store.quota=()=>{throw Error('Simulated disk write failure');};
  const s=f.manager.start({},a.id);f.children[0].complete();await until(()=>f.manager.get(s.id).status==='verification_failed');
  assert.equal(f.store.accounts()[0].credentialsPath,a.credentialsPath);
  f.store.quota=save;await f.manager.stop(f.manager.get(s.id));assert.equal(fs.existsSync(a.credentialsPath),true);
});

test('cloud auth retries rejected access tokens; only unrecoverable authentication marks login required',async t=>{
  let mode='expired',calls=0,refreshes=0;
  const f=fixture(t,{quota:{tokenReader:async()=>({accessToken:'fixture-old'}),tokenRefresher:async()=>{refreshes++;if(mode==='revoked')throw Object.assign(Error('invalid grant'),{code:'LOGIN_REQUIRED'});return {accessToken:'fixture-new'};},fetcher:async()=>{calls++;if(mode==='network')throw Error('offline');return mode==='expired'&&calls>1?new Response(JSON.stringify(cloud)):new Response('',{status:401});}}});
  const a=existing(f);await f.monitor.refresh(a);assert.equal(refreshes,1);assert.equal(f.store.accounts()[0].authStatus,'ok');
  mode='network';f.monitor.lastAttempt.clear();await f.monitor.refresh(a);assert.equal(f.store.accounts()[0].authStatus,'ok');assert.equal(f.store.accounts()[0].quotaError,'Subscription usage unavailable');
  mode='revoked';f.monitor.lastAttempt.clear();await f.monitor.refresh(a);assert.equal(f.store.accounts()[0].authStatus,'login_required');
  assert.throws(()=>f.pool.acquire(f.store.saveKey({name:'test'}).key,'anthropic'),/No available/);
  mode='expired';f.monitor.lastAttempt.clear();await f.monitor.refresh(a);assert.equal(f.store.accounts()[0].authStatus,'ok');
});

test('login HTTP API enforces console origin, supports resuming and protects an account during reconnect',async t=>{
  const f=fixture(t);const managed=createManagedServers({...config(),port:0,bindAddress:'127.0.0.1',management:{port:0}},
    {store:f.store,loginOptions:{directory:path.join(f.dir,'http-profiles'),spawnProcess:f.spawnProcess},quotaOptions:{fetcher:async()=>new Response(JSON.stringify(cloud))}});
  await managed.start();
  // fixture owns the database; close only listeners and the managed helpers here.
  t.after(async()=>{await managed.logins.close();await managed.monitor.close();await Promise.all([managed.admin,managed.inference].map(server=>new Promise(resolve=>server.close(resolve))));});
  const base='http://127.0.0.1:'+managed.admin.address().port;
  const send=(url,method='GET',body,headers={})=>fetch(base+url,{method,headers:{'x-proxy-admin':'1','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await send('/admin/logins','POST',{name:'Blocked'},{origin:'https://other.invalid'})).status,403);
  assert.equal((await send('/admin/logins','POST',{name:'Blocked'},{'x-proxy-admin':'0'})).status,403);
  assert.equal((await send('/admin/logins','POST',{name:'Wrong provider',provider:'gemini'})).status,400);
  const created=await send('/admin/logins','POST',{name:'Via console'});assert.equal(created.status,201);const s=await created.json();
  f.children[0].stdout.write(authorize+'\n');
  assert.equal((await (await send('/admin/logins/'+s.id)).json()).authorizationUrl,authorize);
  assert.equal((await (await send('/admin/status')).json()).logins.length,1);
  assert.equal((await send('/admin/logins/'+s.id+'/code','POST',{code:'fixture-code'})).status,200);
  f.children[0].complete();await until(()=>managed.logins.get(s.id).status==='complete');const a=f.store.accounts()[0];
  const reconnect=await (await send('/admin/accounts/'+a.id+'/reconnect','POST')).json();
  assert.equal((await send('/admin/accounts/'+a.id,'DELETE')).status,409);
  assert.equal((await send('/admin/accounts/'+a.id,'PATCH',{name:'Changed'})).status,409);
  assert.equal((await send('/admin/logins/'+reconnect.id,'DELETE')).status,200);
  assert.equal(f.store.accounts()[0].id,a.id);
});
