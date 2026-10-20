const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { load } = require('./helpers');
const { createClient } = require('../src/auth/antigravity');

function credentials(t, token = 'fixture-token', expiry = Date.now()+3600000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credentials.json');
  const write = (access = token, time = expiry) => fs.writeFileSync(file, JSON.stringify({
    token: { access_token: access, refresh_token: 'fixture-refresh', expiry: new Date(time).toISOString() },
  }), { mode: 0o600 });
  write();
  return { file, write };
}

test('Antigravity coalesces renewal/discovery, isolates accounts and invalidates project on token change', async t => {
  const a = credentials(t, 'old-a', Date.now()-1), b = credentials(t, 'fresh-b');
  let renewals = 0, discoveries = 0;
  const client = createClient({
    renew: async filename => { renewals++; assert.equal(filename, a.file); await new Promise(r => setTimeout(r, 10)); a.write('fresh-a', Date.now()+3600000); },
    fetcher: async (url, options) => {
      discoveries++; assert.match(url, /loadCodeAssist$/);
      assert.deepEqual(JSON.parse(options.body), { metadata: { ideType: 'ANTIGRAVITY' } });
      return Response.json({ cloudaicompanionProject: options.headers.authorization });
    },
  });
  const sessions = await Promise.all(Array.from({length:8}, () => client.session({ geminiCredentialsPath: a.file })));
  assert.equal(renewals, 1); assert.equal(discoveries, 1);
  assert.ok(sessions.every(s => s.project === 'Bearer fresh-a'));
  assert.equal((await client.session({geminiCredentialsPath:b.file})).project, 'Bearer fresh-b');
  a.write('replacement-a', Date.now()+3600000);
  assert.equal((await client.session({geminiCredentialsPath:a.file})).project, 'Bearer replacement-a');
  assert.equal(discoveries, 3);
});

test('Antigravity reports cloud model quotas and windows without deriving account usage', async t => {
  const a = credentials(t);
  const client = createClient({fetcher: async url => {
    if (url.endsWith('loadCodeAssist')) return Response.json({cloudaicompanionProject:'fixture'});
    if (url.endsWith('fetchAvailableModels')) return Response.json({models:{
      'gemini-4-argon-medium': {quotaInfo:{remainingFraction:0.04,resetTime:'2026-12-01T00:00:00Z'}},
      invalid: {quotaInfo:{remainingFraction:9}},
    }});
    assert.ok(url.endsWith('retrieveUserQuotaSummary'));
    return Response.json({groups:[{displayName:'Gemini',buckets:[{bucketId:'weekly',
      window:'WEEKLY',remainingFraction:0.25,resetTime:'2026-12-01T00:00:00Z'}]}]});
  }});
  const quota = await client.quota({geminiCredentialsPath:a.file});
  assert.equal(quota.buckets.length,1);
  assert.equal(quota.buckets[0].remainingFraction,0.04);
  assert.equal(quota.groups[0].buckets[0].remainingFraction,0.25);
  assert.equal(quota.groups[0].buckets[0].window,'WEEKLY');
});

test('Antigravity discovery failures expose no body or secrets and do not poison the cache', async t => {
  const a = credentials(t); let calls = 0;
  const client = createClient({fetcher:async () => {
    if (++calls === 1) return new Response('fixture-secret-provider-body',{status:401});
    return Response.json({cloudaicompanionProject:'fixture'});
  }});
  await assert.rejects(client.session({geminiCredentialsPath:a.file}), e =>
    e.code === 'LOGIN_REQUIRED' && !e.message.includes('fixture-secret'));
  assert.equal((await client.session({geminiCredentialsPath:a.file})).project,'fixture');
});

async function fixture(t, originHandler, options = {}) {
  const origin = http.createServer(originHandler);
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  let upstreamCalls = 0;
  const transport = load('src/proxy/antigravity.js', {
    'node:https': {request(opts, callback) {
      upstreamCalls++;
      return http.request({...opts, hostname:'127.0.0.1',port:origin.address().port}, callback);
    }},
    '../auth/antigravity': {session:options.session || (async () => ({
      host:'fixture',project:'server-discovered',accessToken:'fixture-token',userAgent:'fixture-agent',
    }))},
  });
  const proxy = http.createServer((req,res) => {
    let body=''; req.on('data',c=>{body+=c;});
    req.on('end',()=>transport.handleAntigravityRequest(body,req,res,{
      anthropicTimeoutMs:options.timeout || 1000, onUpstreamResponse:options.onResponse,
    }));
  });
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  t.after(async () => {for (const s of [proxy,origin]) {s.closeAllConnections();await new Promise(r=>s.close(r));}});
  const url = `http://127.0.0.1:${proxy.address().port}/v1beta/models/gemini-4-argon-medium:`;
  return { url, calls:()=>upstreamCalls };
}

test('Antigravity forwards native history/tools and unwraps split UTF-8 SSE without losing signatures', async t => {
  const request = {contents:[{role:'model',parts:[{functionCall:{name:'lookup',args:{key:'x'}},thoughtSignature:'signed-history'}]},
    {role:'user',parts:[{functionResponse:{name:'lookup',response:{value:42}}}]}],
    systemInstruction:{parts:[{text:'original system'}]},
    tools:[{functionDeclarations:[{name:'lookup',parameters:{type:'OBJECT',properties:{key:{type:'STRING'}}}}]}]};
  const response = {candidates:[{content:{role:'model',parts:[{text:'caffè ☕',thoughtSignature:'signed-result'}]}}]};
  const f = await fixture(t, (req,res) => {
    let body='';req.on('data',c=>{body+=c;});req.on('end',()=>{
      const envelope=JSON.parse(body);
      assert.deepEqual(envelope.request,request);assert.equal(envelope.project,'server-discovered');
      assert.equal(envelope.userAgent,'antigravity');assert.ok(envelope.requestId);
      assert.equal(req.headers.authorization,'Bearer fixture-token');
      assert.equal(req.headers['x-api-key'],undefined);
      res.writeHead(200,{'content-type':'text/event-stream'});
      const bytes=Buffer.from(`data: ${JSON.stringify({response})}\r\n\r\n`);
      for(const byte of bytes) res.write(Buffer.from([byte]));
      res.end();
    });
  });
  const r=await fetch(f.url+'streamGenerateContent',{method:'POST',body:JSON.stringify(request),headers:{'x-api-key':'caller-key'}});
  assert.equal(r.status,200);
  const event=(await r.text()).trim().slice(6);
  assert.deepEqual(JSON.parse(event),response);
});

test('Antigravity non-streaming uses generateContent and preserves the complete response', async t => {
  const response={candidates:[{content:{parts:[{text:'first'},{text:'second',thoughtSignature:'sig'}]}}],usageMetadata:{totalTokenCount:12}};
  const f=await fixture(t,(req,res)=>{
    assert.equal(req.url,'/v1internal:generateContent');
    res.end(JSON.stringify({response}));
  });
  const r=await fetch(f.url+'generateContent',{method:'POST',body:'{"contents":[]}'});
  assert.deepEqual(await r.json(),response);
});

test('Antigravity never replays generation and sanitizes upstream errors while keeping Retry-After', async t => {
  let notified;
  const f=await fixture(t,(req,res)=>{res.writeHead(429,{'retry-after':'60'});res.end('private diagnostic');},
    {onResponse:status=>{notified=status;}});
  const r=await fetch(f.url+'streamGenerateContent',{method:'POST',body:'{"contents":[]}'});
  assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');
  assert.equal(notified,429);assert.equal(f.calls(),1);
  assert.equal((await r.text()).includes('private'),false);
});

test('Antigravity does not dispatch after caller cancellation during authentication', async t => {
  let resolve, entered;
  const ready=new Promise(r=>{entered=r;});
  const f=await fixture(t,()=>{}, {session:()=>{entered();return new Promise(r=>{resolve=r;});}});
  const req=http.request(f.url+'streamGenerateContent',{method:'POST'});
  req.on('error',()=>{});req.end('{"contents":[]}');await ready;
  req.destroy();await new Promise(r=>setTimeout(r,20));
  resolve({host:'fixture',project:'fixture',accessToken:'fixture'});
  await new Promise(r=>setTimeout(r,20));assert.equal(f.calls(),0);
});

test('Antigravity aborts upstream when its streaming caller disconnects', {timeout:3000}, async t => {
  let closed;const done=new Promise(r=>{closed=r;});
  const f=await fixture(t,(req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: {"response":{"candidates":[]}}\n\n');
    res.on('close',()=>closed(res.writableFinished));
  });
  const req=http.request(f.url+'streamGenerateContent',{method:'POST'},res=>{
    res.on('error',()=>{});res.once('data',()=>res.destroy());
  });
  req.on('error',()=>{});req.end('{"contents":[]}');
  assert.equal(await done,false);
});

test('Antigravity uses inactivity rather than total duration; timeout errors contain elapsed time', async t => {
  const f=await fixture(t,(req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    let sent=0;
    const timer=setInterval(()=>{
      res.write('data: {"response":{"candidates":[]}}\n\n');
      if(++sent===5){clearInterval(timer);res.end();}
    },40);
    res.on('close',()=>clearInterval(timer));
  },{timeout:120});
  const r=await fetch(f.url+'streamGenerateContent',{method:'POST',body:'{"contents":[]}'});
  assert.equal((await r.text()).match(/data:/g).length,5);
  const idle=await fixture(t,()=>{}, {timeout:50});
  const timeout=await fetch(idle.url+'generateContent',{method:'POST',body:'{"contents":[]}'});
  assert.equal(timeout.status,504);assert.match((await timeout.json()).error.message,/seconds elapsed/);
});
