const path=require('node:path');
const fs=require('node:fs');
const {MediaJobs}=require('../media/jobs');
const {MediaError}=require('../media/errors');
const codex=require('./codex');
function request(input,agentModel) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['prompt','aspect_ratio','transparent_background'].includes(k)))throw new MediaError('invalid_input','Unexpected image request fields');
  if(typeof input.prompt!=='string' || !input.prompt.trim() || input.prompt.length>12000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.prompt))throw new MediaError('invalid_input','prompt must contain 1–12000 characters without control characters');
  const ratio=input.aspect_ratio ?? 'square',transparent=input.transparent_background ?? false;
  if(!['square','landscape','portrait'].includes(ratio) || typeof transparent!=='boolean')throw new MediaError('invalid_input','Invalid image aspect ratio or transparency');
  return {prompt:input.prompt.trim(),aspect_ratio:ratio,transparent_background:transparent,model:'gpt-image-2',...(agentModel?{agent_model:agentModel}:{})};
}
class ImageService extends MediaJobs {
  constructor(config,store,pool,overrides={}) {
    const settings=config.images || {};
    super(config,store,pool,'image','codex',{maxConcurrent:1,maxOutputBytes:20*1024*1024,...settings});
    if(typeof settings.codexHome!=='string' || !path.isAbsolute(settings.codexHome))throw new Error('images.codexHome must be an absolute account directory');
    this.agentModel=settings.agentModel || null;
    if(this.agentModel && !/^gpt-[a-zA-Z0-9.-]{1,80}$/.test(this.agentModel))throw new Error('Invalid image agent model');
    Object.assign(this.options,{codexHome:settings.codexHome,codexPath:settings.codexPath || 'codex'});
    this.generate=overrides.generate || codex.generate;
    this.preflight=()=> {this.privateHome();return (overrides.preflight || codex.preflight)(this.options);};
  }
  parse(input) {return request(input,this.agentModel);}
  metadata(job) {return {aspect_ratio:job.aspect_ratio,transparent_background:job.transparent_background};}
  admit(key) {return this.pool.reserve(key,{id:'codex-image-worker',provider:'codex',maxConcurrent:this.limit});}
  privateHome() {
    const stat=fs.statSync(this.options.codexHome);
    if(!stat.isDirectory() || (stat.mode & 0o077)!==0 || (process.getuid && stat.uid!==process.getuid()))throw new MediaError('codex_home_permissions','Codex account directory must be private and owned by the service user',503);
  }
  process(id,job,entry,directory) {this.privateHome();return this.generate(job,directory,this.options,entry.controller.signal);}
}
module.exports={ImageService,request};
