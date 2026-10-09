const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { integer,hash } = require('../management/store');
const { request,VideoError } = require('./storyboard');
const { generate } = require('./generate');
const TERMINAL=['completed','failed','interrupted','cancelled'];

class VideoService {
  constructor(config,store,pool,handler,overrides={}) {
    const settings=config.video || {};
    this.config=config;this.store=store;this.pool=pool;this.handler=handler;
    this.generate=overrides.generate || generate;
    this.render=overrides.render || require('./render').render;
    this.preflight=overrides.preflight || (overrides.render?async()=>{}:require('./render').preflight);
    this.model=settings.model || 'claude-opus-5-5';
    if(!/^claude-(opus|sonnet|haiku)-5-5$/.test(this.model))throw new Error('Unsupported video storyboard model');
    this.options={ffmpegPath:settings.ffmpegPath || 'ffmpeg',fontFile:settings.fontFile || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      maxOutputBytes:integer(settings.maxOutputBytes,50*1024*1024,100*1024*1024)};
    this.directory=path.resolve(settings.directory || path.join(path.dirname(config.management.databasePath || 'data/proxy.sqlite'),'videos'));
    this.limit=integer(settings.maxConcurrent,2,8);
    this.maxJobs=integer(settings.maxJobs,1000,100000);
    this.maxStorageBytes=integer(settings.maxStorageBytes,1024*1024*1024,10*1024*1024*1024);
    this.retentionMs=integer(settings.retentionHours,168,720)*3600000;
    this.timeoutMs=integer(settings.timeoutMs,300000,3600000);
    this.active=new Map();this.accepting=true;this.counter=0;
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.chmodSync(this.directory,0o700);
    store.db.exec(`CREATE TABLE IF NOT EXISTS video_jobs (
      id TEXT PRIMARY KEY, keyId TEXT NOT NULL, idempotencyDigest TEXT NOT NULL,
      fingerprint TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, errorCode TEXT, storyboard TEXT, media TEXT,
      UNIQUE(keyId,idempotencyDigest));
      CREATE INDEX IF NOT EXISTS video_jobs_time ON video_jobs(createdAt);`);
    // A previous model invocation may have consumed quota. Never replay it.
    store.db.prepare("UPDATE video_jobs SET status='interrupted',errorCode='interrupted_restart',updatedAt=? WHERE status NOT IN ('completed','failed','interrupted','cancelled')").run(Date.now());
    for(const row of store.db.prepare("SELECT id FROM video_jobs WHERE status='interrupted'").all())fs.rmSync(path.join(this.directory,row.id),{recursive:true,force:true});
    this.prune();
  }
  async ready() { await this.preflight(this.options); }
  status() { return {enabled:true,active:this.active.size,maxConcurrent:this.limit}; }
  public(row) {
    const job=JSON.parse(row.request),base=`/v1/video-jobs/${row.id}`;
    return {id:row.id,status:row.status,model:job.model,format:job.format,duration_seconds:job.duration_seconds,
      created_at:new Date(row.createdAt).toISOString(),updated_at:new Date(row.updatedAt).toISOString(),
      ...(row.errorCode?{error:{code:row.errorCode}}:{}),
      ...(row.storyboard?{storyboard_url:base+'/storyboard'}:{}),
      ...(row.status==='completed'?{content_url:base+'/content',poster_url:base+'/poster',media:JSON.parse(row.media)}:{})};
  }
  get(id,key) {
    const row=this.store.db.prepare('SELECT * FROM video_jobs WHERE id=? AND keyId=?').get(id,key.id);
    if(!row)throw new VideoError('not_found','Video job not found',404);
    if(!this.active.has(id) && row.createdAt<Date.now()-this.retentionMs)throw new VideoError('expired','Video job expired',410);
    return row;
  }
  update(id,status,extra={}) {
    this.store.db.prepare('UPDATE video_jobs SET status=?,updatedAt=?,errorCode=?,storyboard=COALESCE(?,storyboard),media=COALESCE(?,media) WHERE id=?')
      .run(status,Date.now(),extra.errorCode || null,extra.storyboard?JSON.stringify(extra.storyboard):null,extra.media?JSON.stringify(extra.media):null,id);
  }
  create(input,key,sourceIP,idempotency) {
    if(typeof idempotency!=='string' || !/^[\x21-\x7e]{1,200}$/.test(idempotency))throw new VideoError('idempotency_required','A 1–200 character Idempotency-Key is required');
    const job=request(input,this.model),serialized=JSON.stringify(job),fingerprint=hash(serialized),digest=hash(idempotency);
    const old=this.store.db.prepare('SELECT * FROM video_jobs WHERE keyId=? AND idempotencyDigest=?').get(key.id,digest);
    if(old) {
      if(old.fingerprint!==fingerprint)throw new VideoError('idempotency_conflict','Idempotency-Key already used for different content',409);
      return this.public(this.get(old.id,key));
    }
    if(!this.accepting || !this.pool.accepting)throw new VideoError('draining','Video worker is draining',503);
    if(this.active.size>=this.limit)throw new VideoError('video_capacity','Video concurrency limit reached',429);
    this.prune();
    const rows=this.store.db.prepare('SELECT id FROM video_jobs').all();
    const used=rows.reduce((sum,row)=>sum+this.diskUsage(row.id),0);
    if(rows.length>=this.maxJobs || used+(this.active.size+1)*this.options.maxOutputBytes>this.maxStorageBytes)throw new VideoError('video_storage_limit','Video storage limit reached',503);
    const lease=this.pool.acquire(key,'anthropic',sourceIP,job.model),id=randomUUID(),now=Date.now();
    try {
      this.store.db.prepare('INSERT INTO video_jobs(id,keyId,idempotencyDigest,fingerprint,request,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,key.id,digest,fingerprint,serialized,'accepted',now,now);
    } catch(error) {lease.release();throw error;}
    const controller=new AbortController(),entry={controller,lease,promise:null};this.active.set(id,entry);
    // Persist before acknowledging. Admission slots are reserved synchronously.
    entry.promise=new Promise(resolve=>setImmediate(resolve)).then(()=>this.run(id,job,key,entry));
    entry.promise.catch(()=>console.error('[VIDEO] Failed to persist video job outcome'));
    return this.public(this.get(id,key));
  }
  async run(id,job,key,entry) {
    let requestId,timedOut=false;
    const directory=path.join(this.directory,id),signal=entry.controller.signal;
    const timeout=setTimeout(()=>{timedOut=true;entry.controller.abort();},this.timeoutMs);
    const authorized=()=>this.store.keys().some(k=>k.id===key.id && k.enabled && k.providers.includes('anthropic'));
    // Revocation cancels background work; rotating a key preserves its identity.
    const revocation=setInterval(()=>{if(!authorized())entry.controller.abort();},1000);
    try {
      if(signal.aborted || !authorized())throw new VideoError('cancelled','Video job cancelled',409);
      fs.mkdirSync(directory,{mode:0o700});
      this.update(id,'generating');
      requestId=this.store.begin({keyId:key.id,accountId:entry.lease.account.id,provider:'anthropic',model:job.model});
      const scoped={...this.config,credsPath:entry.lease.account.credentialsPath,
        onUpstreamResponse:(status,headers)=>this.pool.response(entry.lease.account,status,headers)};
      const plan=await this.generate(job,scoped,this.handler,signal,++this.counter);
      this.store.finish(requestId,200,'completed');requestId=null;entry.lease.release();
      if(signal.aborted || !authorized())throw new VideoError('cancelled','Video job cancelled',409);
      this.update(id,'rendering',{storyboard:plan});
      const media=await this.render(plan,job,directory,this.options,signal);
      if(signal.aborted || !authorized())throw new VideoError('cancelled','Video job cancelled',409);
      this.update(id,'completed',{media});
    } catch(error) {
      if(requestId)this.store.finish(requestId,error.status || 502,signal.aborted?'disconnected':'video_generation_failed');
      this.update(id,signal.aborted?(timedOut?'failed':'cancelled'):'failed',
        {errorCode:timedOut?'video_timeout':signal.aborted?'cancelled':error instanceof VideoError?error.code:'video_failed'});
      fs.rmSync(directory,{recursive:true,force:true});
    } finally {clearTimeout(timeout);clearInterval(revocation);entry.lease.release();this.active.delete(id);}
  }
  cancel(id,key) {
    const row=this.get(id,key);
    if(this.active.has(id))this.active.get(id).controller.abort();
    else if(row.status==='completed')throw new VideoError('already_completed','Completed videos cannot be cancelled',409);
    return this.public(this.get(id,key));
  }
  diskUsage(id) {
    const dir=path.join(this.directory,id);if(!fs.existsSync(dir))return 0;
    return fs.readdirSync(dir).reduce((sum,name)=>sum+fs.lstatSync(path.join(dir,name)).size,0);
  }
  prune() {
    const expired=this.store.db.prepare("SELECT id FROM video_jobs WHERE createdAt<? AND status IN ('completed','failed','interrupted','cancelled')").all(Date.now()-this.retentionMs);
    for(const {id} of expired) {fs.rmSync(path.join(this.directory,id),{recursive:true,force:true});this.store.db.prepare('DELETE FROM video_jobs WHERE id=?').run(id);}
  }
  async close() {
    this.accepting=false;
    for(const entry of this.active.values())entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(entry=>entry.promise));
  }
}
module.exports={VideoService,TERMINAL};
