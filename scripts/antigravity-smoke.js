// Opt-in live test. Uses account quota; never executes returned tools.
// node scripts/antigravity-smoke.js [runtime-directory] [--test-renewal]
// Run as the user with an existing authenticated AGY profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, randomInt } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const { createManagedServers } = require(path.join(root, 'src/management/server'));
const { createClient } = require(path.join(root, 'src/auth/antigravity'));
const home = os.homedir();
const profile = path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token');
const temp = fs.mkdtempSync(path.join(home, '.cache/agy-smoke-'));
fs.chmodSync(temp, 0o700);
let servers;

async function main() {
  const command = process.env.AGY_COMMAND || path.join(home, '.local/bin/agy');
  if (process.argv.includes('--test-renewal')) {
    // The official CLI refreshes a private copy; it never rewrites the original profile.
    const file = path.join(temp, 'renewal-home/.gemini/antigravity-cli/antigravity-oauth-token');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const data = JSON.parse(fs.readFileSync(profile, 'utf8'));
    const before = data.token.access_token;
    data.token.expiry = '2000-01-01T00:00:00Z';
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    const client = createClient();
    const session = await client.session({ geminiCredentialsPath: file, antigravityCommand: command });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(session.project);
    assert.ok(Date.parse(after.token.expiry) > Date.now());
    assert.notEqual(after.token.access_token, before);
    console.log('PASS official CLI credential renewal in isolated profile');
  }
  servers = createManagedServers({
    port: 0, bindAddress: '127.0.0.1', geminiBackend: 'antigravity',
    antigravityCommand: command, anthropicTimeoutMs: 120000,
    management: { port: 0, bindAddress: '127.0.0.1', databasePath: path.join(temp, 'proxy.sqlite') },
  });
  const account = servers.store.saveAccount({ provider: 'gemini', name: 'smoke', credentialsPath: profile });
  const { secret } = servers.store.saveKey({ name: 'smoke', providers: ['gemini'] });
  await servers.start();
  const base = `http://127.0.0.1:${servers.inference.address().port}`;
  assert.equal((await fetch(base+'/health')).status, 200);
  const unauthorized = await fetch(base+'/v1beta/models/gemini-3.8-flash-medium:generateContent',
    { method: 'POST', body: '{"contents":[]}' });
  assert.equal(unauthorized.status, 401); await unauthorized.body.cancel();
  await servers.monitor.refresh(account);
  const current = servers.store.accounts()[0];
  assert.ok(current.quota?.buckets.length, 'cloud model quotas missing');
  assert.ok(current.quota?.groups.length, 'cloud usage windows missing');
  console.log('PASS loopback-only managed proxy, health, caller auth, cloud quota');
  async function generate(model, body, streaming) {
    const response = await fetch(`${base}/v1beta/models/${model}:${streaming?'streamGenerateContent':'generateContent'}`, {
      method: 'POST', headers: { 'x-api-key': secret, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    assert.equal(response.status, 200, `generation HTTP ${response.status}`);
    if (!streaming) {
      const result = await response.json();
      return result.candidates.flatMap(c => c.content.parts);
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const parts = []; let buffer = '', events = 0;
    const parse = () => {
      let end;
      while ((end=buffer.indexOf('\n\n')) >= 0) {
        const frame=buffer.slice(0,end); buffer=buffer.slice(end+2);
        if(!frame.startsWith('data: ')) continue;
        const result=JSON.parse(frame.slice(6)); events++;
        assert.ok(!result.error, 'in-band stream error');
        for(const candidate of result.candidates||[]) parts.push(...candidate.content?.parts||[]);
      }
    };
    while(true) {
      const {done,value}=await reader.read(); if(done) break;
      buffer+=decoder.decode(value,{stream:true}); parse();
    }
    buffer+=decoder.decode(); parse();
    assert.ok(events>0);
    return parts;
  }
  for(const model of ['gemini-3.8-flash-medium','gemini-4-argon-medium']) {
    const marker='fixture_'+randomBytes(4).toString('hex'), value=randomInt(10000,99999);
    const request={
      systemInstruction:{parts:[{text:'Use the supplied lookup tool. After its result, reply exactly MARKER:VALUE using the marker from history and the value from the tool. Do not invent values.'}]},
      contents:[
        {role:'user',parts:[{text:'Remember this marker: '+marker}]},
        {role:'model',parts:[{text:'I will remember it.'}]},
        {role:'user',parts:[{text:'Look up key sample using hermes_probe_lookup and report it.'}]},
      ],
      tools:[{functionDeclarations:[{name:'hermes_probe_lookup',description:'Read a synthetic fixture value.',
        parameters:{type:'OBJECT',properties:{key:{type:'STRING'}},required:['key']}}]}],
      toolConfig:{functionCallingConfig:{mode:'ANY',allowedFunctionNames:['hermes_probe_lookup']}},
      generationConfig:{maxOutputTokens:8192,thinkingConfig:{includeThoughts:true,thinkingBudget:1024}},
    };
    const parts=await generate(model,request,true);
    const calls=parts.filter(p=>p.functionCall).map(p=>p.functionCall);
    assert.equal(calls.length,1); assert.equal(calls[0].name,'hermes_probe_lookup');
    assert.deepEqual(calls[0].args,{key:'sample'});
    assert.ok(parts.some(p=>p.thoughtSignature),'signed tool call missing');
    const result={name:calls[0].name,response:{value}};
    if(calls[0].id)result.id=calls[0].id;
    request.contents.push({role:'model',parts},{role:'user',parts:[{functionResponse:result}]});
    request.toolConfig={functionCallingConfig:{mode:'AUTO'}};
    for(const streaming of [true,false]) {
      const final=await generate(model,request,streaming);
      assert.ok(!final.some(p=>p.functionCall));
      const text=final.filter(p=>!p.thought).map(p=>p.text||'').join('').trim();
      // Do not include response contents in assertion diagnostics.
      assert.ok(text===`${marker}:${value}`,'synthetic result/history mismatch');
    }
    console.log(`PASS ${model}: external tool, signed history, streaming and non-streaming`);
  }
  if(process.env.HERMES_PYTHON && process.env.HERMES_DIRECTORY) {
    await new Promise((resolve,reject)=>{
      const child=spawn(process.env.HERMES_PYTHON,[path.join(root,'scripts/antigravity-hermes-smoke.py')],{
        stdio:['pipe','pipe','ignore'],env:process.env,
      });
      const timer=setTimeout(()=>child.kill('SIGKILL'),150000);
      child.stdout.on('data',data=>process.stdout.write(data));
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Hermes smoke failed'));});
      child.stdin.on('error',()=>{});
      // Bare /models path deliberately tests the original proxy base URL contract.
      child.stdin.end(JSON.stringify({baseUrl:base,key:secret,hermesDirectory:process.env.HERMES_DIRECTORY}));
    });
  }
}
main().catch(error=>{
  // Never print provider bodies, account paths, tokens or assertion data.
  console.error('FAIL live smoke:', error.status ? `HTTP ${error.status}` : error.code || error.name);
  process.exitCode=1;
}).finally(async()=>{
  if(servers)await servers.close({force:true});
  fs.rmSync(temp,{recursive:true,force:true});
});
