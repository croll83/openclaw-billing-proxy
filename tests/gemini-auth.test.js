const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {load}=require('./helpers');
test('Gemini pool refresh is single-flight per account, isolated and atomically private',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-pool-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const files=['one','two'].map(name=>{const file=path.join(dir,name+'.json');fs.writeFileSync(file,JSON.stringify({access_token:'old-'+name,refresh_token:'refresh-'+name,expiry_date:1,unrelated:name}));return file;});
 let calls=0;
 const auth=load('src/auth/geminiToken.js',{https:{request(options,callback){calls++;const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.end=body=>setImmediate(()=>{const token=new URLSearchParams(body).get('refresh_token');const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',Buffer.from(JSON.stringify({access_token:'new-'+token,expires_in:3600})));res.emit('end');});return req;}}},'',{URLSearchParams});
 const one=auth.getGeminiTokenSync(files[0]),two=auth.getGeminiTokenSync(files[1]);
 const a=auth.refreshGeminiToken(one.creds,one.credsPath,{}),b=auth.refreshGeminiToken(one.creds,one.credsPath,{}),c=auth.refreshGeminiToken(two.creds,two.credsPath,{});
 assert.equal(a,b);const results=await Promise.all([a,b,c]);assert.equal(calls,2);assert.notEqual(results[0],results[2]);
 assert.equal(auth.getGeminiTokenSync(files[0]).token,'new-refresh-one');assert.equal(auth.getGeminiTokenSync(files[1]).token,'new-refresh-two');
 for(const file of files)assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(JSON.parse(fs.readFileSync(files[0])).unrelated,'one');assert.equal(fs.readdirSync(dir).length,2);
});
