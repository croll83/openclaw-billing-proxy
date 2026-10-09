const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {PNG}=require('pngjs');
const {Store}=require('../src/management/store');
const {createManagedServers}=require('../src/management/server');
const {environment,validatePNG,CODEX_VERSION,output,cleanup}=require('../src/image/codex');
const {request,ImageService}=require('../src/image/service');
const {config}=require('./helpers');
const input={prompt:'Un piccolo cesto arancione, fotografia su fondo blu.',aspect_ratio:'square'};
function png(alpha=255) {
  const p=new PNG({width:32,height:32});
  for(let i=0;i<p.data.length;i+=4){p.data[i]=255;p.data[i+1]=128;p.data[i+2]=32;p.data[i+3]=alpha;}
  return PNG.sync.write(p);
}
async function fixture(t,extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbp-images-')),home=path.join(dir,'codex');fs.mkdirSync(home,{mode:0o700});
  const executable=path.join(dir,'fake-codex');
  fs.writeFileSync(path.join(home,'mode'),extra.mode || 'ok');
  fs.writeFileSync(executable,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const home=process.env.CODEX_HOME,mode=fs.readFileSync(path.join(home,'mode'),'utf8');
if(process.argv.includes('--version')){console.log('codex-cli '+(mode==='wrong-version'?'0.100.0':'${CODEX_VERSION}'));process.exit(0);}
if(process.argv.includes('features')){console.log('image_generation stable true');process.exit(0);}
if(process.argv.includes('login')){console.error(mode==='api'?'Logged in using an API key':'Logged in using ChatGPT');process.exit(0);}
fs.appendFileSync(path.join(home,'calls'),'1\\n');
fs.writeFileSync(path.join(home,'seen'),JSON.stringify({args:process.argv.slice(2),apiKey:!!process.env.OPENAI_API_KEY,accessToken:!!process.env.CODEX_ACCESS_TOKEN,baseURL:!!process.env.OPENAI_BASE_URL}));
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
const id=require('node:crypto').randomUUID(),folder=path.join(home,'generated_images',id);
const event=e=>console.log(JSON.stringify(e));event({type:'thread.started',thread_id:id});
if(mode==='stall'){setInterval(()=>{},1000);return;}
if(mode==='tool'){event({type:'item.completed',item:{type:'command_execution'}});return;}
if(mode==='quota'){event({type:'turn.failed',error:{code:'usage_limit_exceeded',message:'private-account-secret'}});process.exitCode=1;return;}
if(mode!=='missing'){
fs.mkdirSync(folder,{recursive:true});
fs.writeFileSync(path.join(folder,'exec-image.png'),Buffer.from('${png().toString('base64')}','base64'));
if(mode==='invalid')fs.writeFileSync(path.join(folder,'exec-image.png'),'private-account-secret');
if(mode==='duplicate')fs.writeFileSync(path.join(folder,'exec-other.png'),Buffer.from('${png().toString('base64')}','base64'));
}
event({type:'turn.completed'});
});`,{mode:0o700});
  const store=new Store(path.join(dir,'state.sqlite')),{key,secret}=store.saveKey({name:'images',providers:['codex'],maxConcurrent:2});
  const cfg={...config(),port:0,bindAddress:'127.0.0.1',management:{enabled:true,port:0,databasePath:path.join(dir,'state.sqlite')},
    images:{enabled:true,codexPath:executable,codexHome:home,directory:path.join(dir,'images'),maxConcurrent:1,...extra.images}};
  const managed=createManagedServers(cfg,{store,quotaOptions:{tokenReader:async()=>{throw new Error('no live credentials');}}});
  t.after(async()=>{await managed.close({force:true});fs.rmSync(dir,{recursive:true,force:true});});await managed.start();
  const base=`http://127.0.0.1:${managed.inference.address().port}`;
  const send=(route='',method='POST',body=input,token=secret,headers={})=>fetch(base+'/v1/image-jobs'+route,
    {method,headers:{'x-api-key':token,'content-type':'application/json','idempotency-key':'image-1',...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  const wait=async id=>{
    for(let i=0;i<500;i++) {const job=await (await send('/'+id,'GET')).json();if(['completed','failed','cancelled','interrupted'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}
    throw new Error('job did not complete');
  };
  return {dir,home,store,key,secret,managed,send,wait,cfg,base,calls:()=>fs.existsSync(path.join(home,'calls'))?fs.readFileSync(path.join(home,'calls'),'utf8').trim().split('\n').length:0};
}
test('image input, decoded PNG dimensions, CRC and transparency are validated',()=>{
  assert.equal(request({prompt:' x '}).prompt,'x');
  for(const bad of [{prompt:'x',url:'file:///secret'},{prompt:'x',aspect_ratio:'4k'},{prompt:'x',transparent_background:'yes'},{prompt:'\0'}])assert.throws(()=>request(bad));
  const options={maxOutputBytes:200000};assert.equal(validatePNG(png(),options,false).width,32);
  assert.equal(validatePNG(png(0),options,true).transparent,true);assert.throws(()=>validatePNG(png(),options,true),/transparency/);
  const broken=Buffer.from(png());broken[40]^=1;assert.throws(()=>validatePNG(broken,options,false));
  const huge=Buffer.from(png());huge.writeUInt32BE(1000000,16);assert.throws(()=>validatePNG(huge,options,false),/pixel/);
});
test('worker environment never inherits API keys or provider URLs',()=>{
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','ANTHROPIC_API_KEY'])assert.equal(environment({codexHome:'/test'})[key],undefined);
});
test('real worker process protocol produces an authenticated private image job with metadata',async t=>{
  const f=await fixture(t);assert.equal((await f.send('','POST',input,'bad')).status,401);
  const regular=f.store.saveKey({name:'existing'});assert.deepEqual(regular.key.providers,['anthropic','gemini']);
  assert.equal((await f.send('','POST',input,regular.secret)).status,403);
  const r=await f.send();assert.equal(r.status,202);const created=await r.json(),done=await f.wait(created.id);
  assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.model,'gpt-image-2');assert.equal(done.media.width,32);assert.match(done.media.sha256,/^[a-f0-9]{64}$/);
  const seen=JSON.parse(fs.readFileSync(path.join(f.home,'seen')));
  assert.equal(seen.apiKey,false);assert.equal(seen.accessToken,false);assert.equal(seen.baseURL,false);
  assert.ok(seen.args.includes('read-only'));assert.ok(seen.args.includes('shell_tool'));assert.ok(seen.args.includes('forced_login_method="chatgpt"'));
  assert.equal((await f.send('/'+created.id+'/content','GET',null,regular.secret)).status,403);
  const another=f.store.saveKey({name:'other-images',providers:['codex']});
  assert.equal((await f.send('/'+created.id+'/content','GET',null,another.secret)).status,404);
  const file=await f.send('/'+created.id+'/content','GET');assert.equal(file.headers.get('content-type'),'image/png');assert.equal(validatePNG(Buffer.from(await file.arrayBuffer()),{maxOutputBytes:20000},false).width,32);
  assert.equal((await f.send('/'+created.id+'/content','HEAD')).headers.get('content-length'),String(png().length));
  assert.equal(f.managed.pool.active,0);assert.equal(f.store.report(5)[0].provider,'codex');
  assert.equal(fs.readdirSync(path.join(f.home,'generated_images')).length,0);
  const rotated=f.store.rotateKey(f.key.id).secret;assert.equal((await f.send('/'+created.id,'GET',null,rotated)).status,200);
});
test('simultaneous image retries produce one native worker invocation, conflicts return 409',async t=>{
  const f=await fixture(t),responses=await Promise.all(Array.from({length:12},()=>f.send()));
  const jobs=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(jobs.map(j=>j.id)).size,1);
  assert.equal((await f.wait(jobs[0].id)).status,'completed');assert.equal(f.calls(),1);
  assert.equal((await f.send('','POST',{...input,prompt:'other'})).status,409);
});
test('image capacity shares global/caller limits with normal inference and cancellation releases them',async t=>{
  const f=await fixture(t,{mode:'stall'});f.managed.pool.limit=1;
  f.store.saveKey({providers:['codex','anthropic'],maxConcurrent:10},f.key.id);
  const job=await (await f.send()).json();
  assert.equal((await f.send('','POST',input,f.secret,{'idempotency-key':'other'})).status,429);
  const normal=await fetch(f.base+'/v1/messages',{method:'POST',headers:{'x-api-key':f.secret},body:JSON.stringify({model:'claude-opus-5-5'})});
  assert.equal(normal.status,429);
  assert.equal(f.managed.pool.byKey.get(f.key.id),1);
  assert.equal((await f.send('/'+job.id+'/content','GET')).status,409);
  await f.send('/'+job.id,'DELETE');assert.equal((await f.wait(job.id)).status,'cancelled');assert.equal(f.managed.pool.active,0);
  assert.equal(fs.existsSync(path.join(f.dir,'images',job.id)),false);
});
test('startup rejects API-key accounts and untested Codex versions before accepting requests',async t=>{
  await assert.rejects(fixture(t,{mode:'api'}),/ChatGPT account/);
  await assert.rejects(fixture(t,{mode:'wrong-version'}),/requires Codex/);
});
test('unsafe account-directory permissions reject work before a worker starts',async t=>{
  const f=await fixture(t);fs.chmodSync(f.home,0o755);
  const job=await (await f.send()).json(),done=await f.wait(job.id);
  assert.equal(done.error.code,'codex_home_permissions');assert.equal(f.calls(),0);
});
test('disabled image jobs preserve existing routes; storage admission does not start a worker',async t=>{
  const off=await fixture(t,{images:{enabled:false}});assert.equal((await off.send()).status,404);assert.equal(off.managed.images,null);
  assert.equal(off.store.db.prepare("SELECT name FROM sqlite_master WHERE name='image_jobs'").get(),undefined);
  const full=await fixture(t,{images:{maxStorageBytes:1}});assert.equal((await full.send()).status,503);assert.equal(full.calls(),0);assert.equal(full.managed.pool.active,0);
});
test('worker quota, missing/invalid output and prohibited tools fail safely without retry',async t=>{
  for(const [mode,code] of [['quota','image_usage_limit'],['missing','image_output_missing'],['invalid','invalid_image'],['duplicate','image_output_ambiguous'],['tool','image_tool_policy']]) {
    const f=await fixture(t,{mode}),created=await (await f.send()).json(),job=await f.wait(created.id);
    assert.equal(job.status,'failed');assert.equal(job.error.code,code);assert.equal(JSON.stringify(job).includes('secret'),false);
    await f.send();assert.equal(f.calls(),1);assert.equal(f.managed.pool.active,0);
  }
});
test('API-key mode is refused per job before generation, and timeouts stop worker processes',async t=>{
  const f=await fixture(t);fs.writeFileSync(path.join(f.home,'mode'),'api');
  let job=await (await f.send()).json();assert.equal((await f.wait(job.id)).status,'failed');assert.equal(f.calls(),0);
  fs.writeFileSync(path.join(f.home,'mode'),'stall');f.managed.images.timeoutMs=100;
  job=await (await f.send('','POST',input,f.secret,{'idempotency-key':'timeout'})).json();
  const done=await f.wait(job.id);assert.equal(done.error.code,'image_timeout');assert.equal(f.managed.pool.active,0);
});
test('image revocation cancels a running worker and retention removes private files',async t=>{
  const f=await fixture(t,{mode:'stall'}),job=await (await f.send()).json();
  f.store.saveKey({providers:['anthropic']},f.key.id);
  for(let i=0;i<160 && f.managed.images.active.size;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.managed.images.active.size,0);assert.equal(f.store.db.prepare('SELECT status FROM image_jobs WHERE id=?').get(job.id).status,'cancelled');
  f.store.saveKey({providers:['codex']},f.key.id);fs.writeFileSync(path.join(f.home,'mode'),'ok');
  const second=await (await f.send('','POST',input,f.secret,{'idempotency-key':'completed'})).json();await f.wait(second.id);
  f.store.db.prepare('UPDATE image_jobs SET createdAt=? WHERE id=?').run(Date.now()-8*86400000,second.id);
  assert.equal((await f.send('/'+second.id+'/content','GET')).status,410);f.managed.images.prune();assert.equal(fs.existsSync(path.join(f.dir,'images',second.id)),false);
});
test('image restart preserves receipt and marks unfinished jobs interrupted without consuming quota',async t=>{
  const f=await fixture(t),job=await (await f.send()).json();await f.wait(job.id);
  f.store.db.prepare("UPDATE image_jobs SET status='generating' WHERE id=?").run(job.id);
  const worker=new ImageService(f.cfg,f.store,f.managed.pool);t.after(()=>worker.close());
  assert.equal(worker.get(job.id,f.key).status,'interrupted');assert.equal(worker.create(input,f.key,'127.0.0.1','image-1').id,job.id);assert.equal(f.calls(),1);
});
test('PNG collection and cleanup reject symlinks and preserve unrelated or stale files',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbp-paths-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id='00000000-0000-4000-8000-000000000000',home=path.join(dir,'home'),other=path.join(dir,'other');fs.mkdirSync(home);fs.mkdirSync(other);
  const folder=path.join(other,id);fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'image.png'),png());fs.symlinkSync(other,path.join(home,'generated_images'));
  const options={codexHome:home,maxOutputBytes:20000},started=Date.now();
  assert.throws(()=>output(options,id,started,{transparent_background:false}));cleanup(options,id,started);assert.equal(fs.existsSync(folder),true);
  fs.unlinkSync(path.join(home,'generated_images'));fs.mkdirSync(path.join(home,'generated_images'));
  fs.symlinkSync(folder,path.join(home,'generated_images',id));assert.throws(()=>output(options,id,started,{}));cleanup(options,id,started);assert.equal(fs.existsSync(folder),true);
  fs.unlinkSync(path.join(home,'generated_images',id));fs.mkdirSync(path.join(home,'generated_images',id));
  const target=path.join(home,'generated_images',id,'image.png');fs.symlinkSync(path.join(folder,'image.png'),target);assert.throws(()=>output(options,id,started,{}));
  fs.unlinkSync(target);fs.writeFileSync(target,png());fs.utimesSync(target,1,1);fs.utimesSync(path.dirname(target),1,1);assert.throws(()=>output(options,id,started,{}));cleanup(options,id,started);assert.equal(fs.existsSync(target),true);
});
