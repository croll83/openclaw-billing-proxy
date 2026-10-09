const {MediaJobs,TERMINAL}=require('../media/jobs');
const {request}=require('./storyboard');
const {generate}=require('./generate');
class VideoService extends MediaJobs {
  constructor(config,store,pool,handler,overrides={}) {
    const settings=config.video || {};
    super(config,store,pool,'video','anthropic',settings);
    this.handler=handler;this.model=settings.model || 'claude-opus-5-5';
    if(!/^claude-(opus|sonnet|haiku)-5-5$/.test(this.model))throw new Error('Unsupported video storyboard model');
    this.generate=overrides.generate || generate;
    this.render=overrides.render || require('./render').render;
    Object.assign(this.options,{ffmpegPath:settings.ffmpegPath || 'ffmpeg',fontFile:settings.fontFile || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'});
    const check=overrides.preflight || (overrides.render?async()=>{}:require('./render').preflight);
    this.preflight=()=>check(this.options);
  }
  parse(input) {return request(input,this.model);}
  metadata(job) {return {format:job.format,duration_seconds:job.duration_seconds};}
  admit(key,sourceIP,job) {return this.pool.acquire(key,'anthropic',sourceIP,job.model);}
  async process(id,job,entry,directory) {
    const scoped={...this.config,credsPath:entry.lease.account.credentialsPath,
      onUpstreamResponse:(status,headers)=>this.pool.response(entry.lease.account,status,headers)};
    const plan=await this.generate(job,scoped,this.handler,entry.controller.signal,++this.counter);
    this.finishGeneration(entry);
    if(entry.controller.signal.aborted)throw new Error('cancelled');
    this.update(id,'rendering',{storyboard:plan});
    return this.render(plan,job,directory,this.options,entry.controller.signal);
  }
}
module.exports={VideoService,TERMINAL};
