const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { VideoError, instructions, storyboard } = require('./storyboard');

// Reuse the subscription transport, token refresh and pool callbacks. No API-key
// transport or secondary provider exists on this path.
async function generate(job,config,handler,signal,requestNumber) {
  const req=new EventEmitter();
  Object.assign(req,{method:'POST',url:'/v1/messages',headers:{'content-type':'application/json','anthropic-version':'2023-06-01'}});
  const chunks=[];let size=0;
  const res=new Writable({write(chunk,encoding,callback){
    size+=chunk.length;
    if(size>256*1024) { callback(new VideoError('model_response_too_large','Model response exceeds limit',502));return; }
    chunks.push(Buffer.from(chunk));callback();
  }});
  res.statusCode=200;res.headersSent=false;
  res.writeHead=status=>{res.statusCode=status;res.headersSent=true;return res;};
  const abort=()=>{req.aborted=true;req.emit('aborted');res.destroy(new VideoError('cancelled','Video generation cancelled',409));};
  const done=new Promise((resolve,reject)=>{
    res.once('finish',resolve);res.once('error',reject);
    res.once('close',()=>{if(!res.writableFinished)reject(new VideoError('generation_interrupted','Model response interrupted',502));});
  });
  signal.addEventListener('abort',abort,{once:true});
  const body=JSON.stringify({model:job.model,max_tokens:8192,stream:false,thinking:{type:'adaptive'},
    system:instructions(job),messages:[{role:'user',content:job.prompt}]});
  try {
    if(signal.aborted)abort();
    else {
      try { Promise.resolve(handler(body,req,res,config,requestNumber,new Date().toISOString().slice(11,19))).catch(e=>res.destroy(e)); }
      catch(error) { res.destroy(error); }
    }
    await done;
    if(res.statusCode<200 || res.statusCode>=300) throw new VideoError('generation_failed',`Subscription model returned HTTP ${res.statusCode}`,502);
    let value;
    try {
      const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(response.stop_reason!=='end_turn' || !Array.isArray(response.content) || response.content.some(b=>b.type==='tool_use')) throw new Error();
      const output=response.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      if(Buffer.byteLength(output)>64*1024)throw new Error();
      value=JSON.parse(output);
    } catch (_) { throw new VideoError('invalid_model_output','Model did not return a complete JSON storyboard',502); }
    try { return storyboard(value,job.duration_seconds); }
    catch (_) { throw new VideoError('invalid_model_output','Model storyboard failed validation',502); }
  } finally { signal.removeEventListener('abort',abort); }
}
module.exports={generate};
