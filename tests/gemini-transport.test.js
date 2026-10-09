const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {once}=require('node:events');const {load,config}=require('./helpers');
async function fixture(t,native,originHandler,auth={}){
 const origin=http.createServer(originHandler);origin.listen(0,'127.0.0.1');await once(origin,'listening');let calls=0;
 const transport=load(native?'src/proxy/geminiNative.js':'src/proxy/gemini.js',{
  https:{request(options,callback){calls++;return http.request({...options,hostname:'127.0.0.1',port:origin.address().port},callback);}},
  '../auth/geminiToken':{getGeminiTokenSync:()=>({token:'fixture',needsRefresh:false}),...auth}
 });
 const handler=native?transport.handleGeminiNativeRequest:transport.handleGeminiRequest;
 const proxy=http.createServer((req,res)=>{req.resume();req.on('end',()=>handler(JSON.stringify({model:'gemini-2.5-pro',stream:true,messages:[{role:'user',content:'fixture'}]}),req,res,{...config(),GEMINI_HOST:'unused',GEMINI_PATH:'/fixture',GEMINI_PROJECT:'fixture',anthropicTimeoutMs:100},1,'test'));});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 t.after(async()=>{for(const server of [proxy,origin]){server.closeAllConnections();await new Promise(r=>server.close(r));}});
 const open=callback=>{const req=http.request({hostname:'127.0.0.1',port:proxy.address().port,method:'POST',path:native?'/v1beta/models/gemini-2.5-pro:streamGenerateContent':'/v1/chat/completions'},callback);req.end('{}');return req;};
 return {open,calls:()=>calls};
}
for(const native of [true,false]){
 test(`Gemini ${native?'native':'converted'} cancels upstream when caller closes`,{timeout:3000},async t=>{
  let closed;const upstreamClosed=new Promise(r=>{closed=r;});
  const f=await fixture(t,native,(req,res)=>{
   res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}}\n\n');
   res.once('close',()=>closed(res.writableFinished));
  });
  f.open(res=>{res.on('error',()=>{});res.once('data',()=>res.destroy());}).on('error',()=>{});
  assert.equal(await upstreamClosed,false);
 });
 test(`Gemini ${native?'native':'converted'} does not dispatch after disconnect during refresh`,{timeout:3000},async t=>{
  let finish,entered;const enteredPromise=new Promise(r=>{entered=r;});
  const f=await fixture(t,native,()=>{}, {getGeminiTokenSync:()=>({needsRefresh:true,creds:{},credsPath:'/fixture'}),refreshGeminiToken:()=>{entered();return new Promise(r=>{finish=r;});}});
  const req=f.open(()=>{});req.on('error',()=>{});await enteredPromise;req.destroy();await new Promise(r=>setTimeout(r,20));finish('fixture');await new Promise(r=>setTimeout(r,20));assert.equal(f.calls(),0);
 });
}
