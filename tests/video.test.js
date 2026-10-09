const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/management/store');
const { createManagedServers } = require('../src/management/server');
const { VideoService } = require('../src/video/service');
const { request,storyboard } = require('../src/video/storyboard');
const { frame,preflight } = require('../src/video/render');
const { config } = require('./helpers');

const plan=(duration=1)=>({scenes:[{duration_seconds:duration,background:'#102030',elements:[
  {type:'bar',x:.08,y:.12,width:.7,height:.025,color:'#fba541',animation:'grow',delay:0},
  {type:'text',text:'Hercle Accelerate\nDall’idea al flusso',x:.08,y:.25,color:'#ffffff',font_size:.06,bold:true,animation:'slide_up',delay:0},
]}]});
const input={prompt:'Presenta Hercle Accelerate, senza inventare dati.',duration_seconds:1,format:'square'};
function modelResponse(planValue=plan()) {return JSON.stringify({stop_reason:'end_turn',content:[{type:'thinking',thinking:'ignored'},{type:'text',text:JSON.stringify(planValue)}]});}
async function fakeRender(planValue,job,dir,options,signal) {
  if(signal.aborted)throw new Error('cancelled');
  const data=Buffer.alloc(128);data.write('ftyp',4);
  fs.writeFileSync(path.join(dir,'video.mp4'),data);fs.writeFileSync(path.join(dir,'poster.png'),'fixture');
  return {bytes:128,sha256:'fixture',width:720,height:720,fps:24,duration_seconds:job.duration_seconds};
}
async function fixture(t,extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbp-video-'));
  const store=new Store(path.join(dir,'state.sqlite'));
  const creds=path.join(dir,'fixture.json');fs.writeFileSync(creds,JSON.stringify({claudeAiOauth:{accessToken:'synthetic-fixture-token'}}));
  const account=store.saveAccount({name:'fixture',credentialsPath:creds});
  store.quota(account.id,{five_hour:{utilization:10},seven_day:{utilization:10}});
  const {key,secret}=store.saveKey({name:'worker',providers:['anthropic']});
  let calls=0,seen=[];
  const handler=(body,req,res,cfg)=>{
    calls++;seen.push({body:JSON.parse(body),req,cfg});
    if(extra.handler)return extra.handler(body,req,res,cfg);
    res.writeHead(200);res.end(modelResponse(plan(JSON.parse(body).system.match(/EXACTLY (\d+) seconds/)[1]*1)));
  };
  const cfg={...config(),port:0,bindAddress:'127.0.0.1',management:{enabled:true,port:0,databasePath:path.join(dir,'state.sqlite')},
    video:{enabled:true,directory:path.join(dir,'videos'),maxConcurrent:2,...extra.video}};
  const managed=createManagedServers(cfg,{store,anthropic:handler,video:extra.real?{}:{render:extra.render || fakeRender},quotaOptions:{tokenReader:async()=>{throw new Error('no live access');}}});
  await managed.start();
  t.after(async()=>{await managed.close({force:true});fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${managed.inference.address().port}`;
  const send=(route='',method='POST',body=input,token=secret,headers={})=>fetch(base+'/v1/video-jobs'+route,
    {method,headers:{'x-api-key':token,'content-type':'application/json','idempotency-key':'job-1',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  const wait=async id=>{
    for(let i=0;i<500;i++) {
      const r=await send('/'+id,'GET'),job=await r.json();
      if(['completed','failed','cancelled','interrupted'].includes(job.status))return job;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('job did not finish');
  };
  return {dir,store,key,secret,account,managed,send,wait,seen,calls:()=>calls};
}

test('video requests and storyboards bound resources and reject executable payloads',()=>{
  assert.equal(request({prompt:'x'}).model,'claude-opus-5-5');
  for(const bad of [{...input,format:'__proto__'},{...input,format:['square']},{...input,duration_seconds:61},{...input,duration_seconds:1.5},{...input,url:'file:///etc/passwd'},{...input,prompt:'\0x'}])assert.throws(()=>request(bad));
  for(const edit of [p=>p.html='<script/>',p=>p.scenes[0].elements[0].color='url(file:///etc/passwd)',p=>p.scenes[0].elements[0].animation='exec',p=>p.scenes[0].duration_seconds=2,p=>p.scenes[0].elements[0].width=2]) {
    const p=plan();edit(p);assert.throws(()=>storyboard(p,1));
  }
  const p=storyboard(plan(),1);p.scenes[0].elements[1].text='<image href="file:///secret"/> & %';
  const svg=frame(p.scenes[0],.8,720,720);
  assert.ok(svg.includes('&lt;image'));assert.ok(!svg.includes('<image'));
});

test('authenticated video lifecycle shares subscription pool; range downloads and key isolation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.send('','POST',input,'wrong')).status,401);
  const other=f.store.saveKey({name:'other',providers:['anthropic']});
  const gemini=f.store.saveKey({name:'gemini',providers:['gemini']});
  assert.equal((await f.send('','POST',input,gemini.secret)).status,403);
  const r=await f.send();assert.equal(r.status,202);const created=await r.json();
  assert.equal(r.headers.get('location'),'/v1/video-jobs/'+created.id);
  const job=await f.wait(created.id);assert.equal(job.status,'completed');assert.equal(f.calls(),1);
  assert.equal(f.seen[0].cfg.credsPath,f.account.credentialsPath);
  assert.equal(f.seen[0].req.url,'/v1/messages');assert.equal(f.seen[0].req.headers['x-api-key'],undefined);
  assert.equal(f.seen[0].body.tools,undefined);assert.equal(f.seen[0].body.model,'claude-opus-5-5');
  assert.equal(f.managed.pool.active,0);assert.equal(f.store.report(5)[0].completed,1);
  assert.equal((await f.send('/'+created.id,'GET',null,other.secret)).status,404);
  assert.equal((await f.send('/'+created.id+'/content','GET',null,other.secret)).status,404);
  const content=await f.send('/'+created.id+'/content','GET',null,f.secret,{range:'bytes=4-7'});
  assert.equal(content.status,206);assert.equal(await content.text(),'ftyp');assert.equal(content.headers.get('content-range'),'bytes 4-7/128');
  assert.equal((await f.send('/'+created.id+'/content','GET',null,f.secret,{range:'bytes=200-'})).status,416);
  assert.equal((await f.send('/'+created.id+'/content','GET',null,f.secret,{range:'bytes=0-1,4-7'})).status,416);
  assert.equal((await f.send('/'+created.id+'/content','HEAD')).headers.get('content-length'),'128');
  assert.equal((await f.send('/'+created.id+'/poster','GET')).headers.get('content-type'),'image/png');
  assert.ok((await (await f.send('/'+created.id+'/storyboard','GET')).json()).scenes);
  const rotated=f.store.rotateKey(f.key.id).secret;
  assert.equal((await f.send('/'+created.id,'GET')).status,401);
  assert.equal((await f.send('/'+created.id,'GET',null,rotated)).status,200);
});

test('concurrent idempotent submissions invoke the model once; conflicting content is rejected',async t=>{
  const f=await fixture(t),responses=await Promise.all(Array.from({length:20},()=>f.send()));
  assert.ok(responses.every(r=>r.status===202));
  const jobs=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(jobs.map(j=>j.id)).size,1);
  assert.equal((await f.wait(jobs[0].id)).status,'completed');assert.equal(f.calls(),1);
  assert.equal((await f.send('','POST',{...input,prompt:'different'})).status,409);
  assert.equal((await f.send('','POST',input,f.secret,{'idempotency-key':''})).status,400);
});

test('admission checks quota and capacity before persisting; invalid inputs never allocate accounts',async t=>{
  const f=await fixture(t,{handler:()=>{},video:{maxConcurrent:1}});
  assert.equal((await f.send('','POST',{...input,script:'x'})).status,400);assert.equal(f.managed.pool.active,0);
  f.store.quota(f.account.id,{five_hour:{utilization:100}});
  assert.equal((await f.send()).status,503);assert.equal(f.store.db.prepare('SELECT count(*) n FROM video_jobs').get().n,0);
  f.store.quota(f.account.id,{five_hour:{utilization:10}});
  const job=await (await f.send()).json();
  assert.equal((await f.send('','POST',input,f.secret,{'idempotency-key':'another'})).status,429);
  assert.equal((await f.send('/'+job.id+'/content','GET')).status,409);
  assert.equal((await f.send('/'+job.id,'DELETE')).status,202);
  assert.equal((await f.wait(job.id)).status,'cancelled');assert.equal(f.managed.pool.active,0);
  assert.equal((await (await f.send()).json()).id,job.id);assert.equal(f.calls(),1);
});

test('provider failure and invalid output expose only safe errors and never retry generation',async t=>{
  for(const [handler,code] of [
    [(body,req,res,cfg)=>{cfg.onUpstreamResponse(429,{'retry-after':'10'});res.writeHead(429);res.end('private-provider-secret');},'generation_failed'],
    [(body,req,res)=>res.end(JSON.stringify({stop_reason:'max_tokens',content:[{type:'text',text:'secret'}]})),'invalid_model_output'],
    [(body,req,res)=>res.end(modelResponse({scenes:[]})),'invalid_model_output'],
    [()=>{throw new Error('private-secret');},'video_failed'],
  ]) {
    const f=await fixture(t,{handler}),job=await (await f.send()).json(),done=await f.wait(job.id);
    assert.equal(done.status,'failed');assert.equal(done.error.code,code);assert.equal(JSON.stringify(done).includes('secret'),false);
    await f.send();assert.equal(f.calls(),1);assert.equal(f.managed.pool.active,0);
    assert.equal(fs.existsSync(path.join(f.dir,'videos',job.id)),false);
  }
});

test('bounded generation timeout cancels transport and releases admission',async t=>{
  const f=await fixture(t,{handler:()=>{},video:{timeoutMs:30}}),job=await (await f.send()).json();
  const done=await f.wait(job.id);assert.equal(done.status,'failed');assert.equal(done.error.code,'video_timeout');
  assert.equal(f.managed.pool.active,0);assert.equal(f.seen[0].req.aborted,true);
});

test('revoking a client cancels background work and denies subsequent asset access',async t=>{
  const f=await fixture(t,{handler:()=>{}}),job=await (await f.send()).json();
  f.store.saveKey({enabled:false},f.key.id);
  for(let i=0;i<150 && f.managed.videos.active.size;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.managed.videos.active.size,0);assert.equal(f.managed.pool.active,0);
  assert.equal(f.store.db.prepare('SELECT status FROM video_jobs WHERE id=?').get(job.id).status,'cancelled');
  assert.equal((await f.send('/'+job.id,'GET')).status,401);
});

test('storage limits reject new work; retention expires assets and bounds idempotency lifetime',async t=>{
  const f=await fixture(t,{video:{maxJobs:1,retentionHours:1}}),job=await (await f.send()).json();await f.wait(job.id);
  assert.equal((await f.send('','POST',input,f.secret,{'idempotency-key':'new'})).status,503);
  f.store.db.prepare('UPDATE video_jobs SET createdAt=? WHERE id=?').run(Date.now()-7200000,job.id);
  assert.equal((await f.send('/'+job.id+'/content','GET')).status,410);
  f.managed.videos.prune();assert.equal(fs.existsSync(path.join(f.dir,'videos',job.id)),false);
  assert.equal((await f.send('','POST',input,f.secret,{'idempotency-key':'new'})).status,202);
});

test('interrupted durable jobs are never automatically regenerated after restart',async t=>{
  const f=await fixture(t),job=await (await f.send()).json();await f.wait(job.id);
  f.store.db.prepare("UPDATE video_jobs SET status='generating' WHERE id=?").run(job.id);
  const worker=new VideoService(f.managed.videos.config,f.store,f.managed.pool,()=>{throw new Error('must not call');},{render:fakeRender});
  t.after(()=>worker.close());
  assert.equal(worker.get(job.id,f.key).status,'interrupted');
  assert.equal(worker.create(input,f.key,'127.0.0.1','job-1').id,job.id);
  assert.equal(worker.active.size,0);assert.equal(f.calls(),1);
});

test('disabled extension preserves legacy inference behavior and does not create video state',async t=>{
  const f=await fixture(t,{video:{enabled:false}});
  assert.equal((await f.send()).status,404);assert.equal(f.managed.videos,null);
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='video_jobs'").get(),undefined);
});

test('missing encoder is detected before a model can consume account quota',async()=>{
  await assert.rejects(preflight({fontFile:__filename,ffmpegPath:'/missing/ffmpeg'}),/FFmpeg/);
});

const ffmpeg=process.env.VIDEO_TEST_FFMPEG,font=process.env.VIDEO_TEST_FONT;
test('actual HTTP job renders a decodable H.264 MP4 and poster through the real renderer',
  {skip:!ffmpeg || !font},async t=>{
    const f=await fixture(t,{real:true,video:{ffmpegPath:ffmpeg,fontFile:font}}),job=await (await f.send()).json();
    const done=await f.wait(job.id);assert.equal(done.status,'completed',JSON.stringify(done));
    assert.equal(done.media.width,720);assert.equal(done.media.duration_seconds,1);assert.match(done.media.sha256,/^[a-f0-9]{64}$/);
    const video=Buffer.from(await (await f.send('/'+job.id+'/content','GET')).arrayBuffer());assert.equal(video.subarray(4,8).toString(),'ftyp');
    const poster=Buffer.from(await (await f.send('/'+job.id+'/poster','GET')).arrayBuffer());assert.equal(poster.subarray(1,4).toString(),'PNG');
    const {execFileSync}=require('node:child_process');
    const progress=execFileSync(ffmpeg,['-v','error','-i',path.join(f.dir,'videos',job.id,'video.mp4'),'-progress','pipe:1','-f','null','-'],{encoding:'utf8'});
    assert.match(progress,/frame=24\n/);
    // FFmpeg versions report either the last frame PTS or its end timestamp.
    const times=[...progress.matchAll(/out_time_us=(\d+)/g)].map(m=>Number(m[1]));
    assert.ok(times.at(-1)>=958333 && times.at(-1)<=1000000);
  });
test('real encoder can be aborted during rendering and leaves no admission slot',
  {skip:!ffmpeg || !font},async t=>{
    const f=await fixture(t,{real:true,video:{ffmpegPath:ffmpeg,fontFile:font}});
    const job=await (await f.send('','POST',{...input,duration_seconds:10})).json();
    for(let i=0;i<100;i++) {if(f.managed.videos.get(job.id,f.key).status==='rendering')break;await new Promise(r=>setTimeout(r,5));}
    await f.send('/'+job.id,'DELETE');assert.equal((await f.wait(job.id)).status,'cancelled');
    assert.equal(f.managed.pool.active,0);assert.equal(fs.existsSync(path.join(f.dir,'videos',job.id)),false);
  });
