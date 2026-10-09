const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { integer,hash } = require('../management/store');
const { MediaError } = require('./errors');
const TERMINAL=['completed','failed','interrupted','cancelled'];

class MediaJobs {
  constructor(config,store,pool,kind,provider,settings={}) {
    if(!['video','image'].includes(kind))throw new Error('Unsupported media job kind');
    this.kind=kind;this.provider=provider;this.table=kind+'_jobs';
    this.config=config;this.store=store;this.pool=pool;
    this.options={maxOutputBytes:integer(settings.maxOutputBytes,50*1024*1024,100*1024*1024)};
    this.directory=path.resolve(settings.directory || path.join(path.dirname(config.management.databasePath || 'data/proxy.sqlite'),kind+'s'));
    this.limit=integer(settings.maxConcurrent,2,8);
    this.maxJobs=integer(settings.maxJobs,1000,100000);
    this.maxStorageBytes=integer(settings.maxStorageBytes,1024*1024*1024,10*1024*1024*1024);
    this.retentionMs=integer(settings.retentionHours,168,720)*3600000;
    this.timeoutMs=integer(settings.timeoutMs,300000,3600000);
    this.active=new Map();this.accepting=true;this.counter=0;
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.chmodSync(this.directory,0o700);
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY, keyId TEXT NOT NULL, idempotencyDigest TEXT NOT NULL,
      fingerprint TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, errorCode TEXT, storyboard TEXT, media TEXT,
      UNIQUE(keyId,idempotencyDigest));
      CREATE INDEX IF NOT EXISTS ${this.table}_time ON ${this.table}(createdAt);`);
    // A previous model invocation may have consumed quota. Never replay it.
    store.db.prepare(`UPDATE ${this.table} SET status='interrupted',errorCode='interrupted_restart',updatedAt=? WHERE status NOT IN ('completed','failed','interrupted','cancelled')`).run(Date.now());
    for(const row of store.db.prepare(`SELECT id FROM ${this.table} WHERE status='interrupted'`).all())fs.rmSync(path.join(this.directory,row.id),{recursive:true,force:true});
    this.prune();
  }
  async ready() { await this.preflight(); }
  status() { return {enabled:true,active:this.active.size,maxConcurrent:this.limit}; }
  public(row) {
    const job=JSON.parse(row.request),base=`/v1/${this.kind}-jobs/${row.id}`;
    return {id:row.id,status:row.status,model:job.model,...this.metadata(job),
      created_at:new Date(row.createdAt).toISOString(),updated_at:new Date(row.updatedAt).toISOString(),
      ...(row.errorCode?{error:{code:row.errorCode}}:{}),
      ...(row.storyboard?{storyboard_url:base+'/storyboard'}:{}),
      ...(row.status==='completed'?{content_url:base+'/content',...(this.kind==='video'?{poster_url:base+'/poster'}:{}),media:JSON.parse(row.media)}:{})};
  }
  get(id,key) {
    const row=this.store.db.prepare(`SELECT * FROM ${this.table} WHERE id=? AND keyId=?`).get(id,key.id);
    if(!row)throw new MediaError('not_found','Media job not found',404);
    if(!this.active.has(id) && row.createdAt<Date.now()-this.retentionMs)throw new MediaError('expired','Media job expired',410);
    return row;
  }
  update(id,status,extra={}) {
    this.store.db.prepare(`UPDATE ${this.table} SET status=?,updatedAt=?,errorCode=?,storyboard=COALESCE(?,storyboard),media=COALESCE(?,media) WHERE id=?`)
      .run(status,Date.now(),extra.errorCode || null,extra.storyboard?JSON.stringify(extra.storyboard):null,extra.media?JSON.stringify(extra.media):null,id);
  }
  create(input,key,sourceIP,idempotency) {
    if(typeof idempotency!=='string' || !/^[\x21-\x7e]{1,200}$/.test(idempotency))throw new MediaError('idempotency_required','A 1–200 character Idempotency-Key is required');
    const job=this.parse(input),serialized=JSON.stringify(job),fingerprint=hash(serialized),digest=hash(idempotency);
    const old=this.store.db.prepare(`SELECT * FROM ${this.table} WHERE keyId=? AND idempotencyDigest=?`).get(key.id,digest);
    if(old) {
      if(old.fingerprint!==fingerprint)throw new MediaError('idempotency_conflict','Idempotency-Key already used for different content',409);
      return this.public(this.get(old.id,key));
    }
    if(!this.accepting || !this.pool.accepting)throw new MediaError('draining','Media worker is draining',503);
    if(this.active.size>=this.limit)throw new MediaError(this.kind+'_capacity','Media concurrency limit reached',429);
    this.prune();
    const rows=this.store.db.prepare(`SELECT id FROM ${this.table}`).all();
    const used=rows.reduce((sum,row)=>sum+this.diskUsage(row.id),0);
    if(rows.length>=this.maxJobs || used+(this.active.size+1)*this.options.maxOutputBytes>this.maxStorageBytes)throw new MediaError(this.kind+'_storage_limit','Media storage limit reached',503);
    const lease=this.admit(key,sourceIP,job),id=randomUUID(),now=Date.now();
    try {
      this.store.db.prepare(`INSERT INTO ${this.table}(id,keyId,idempotencyDigest,fingerprint,request,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)`)
        .run(id,key.id,digest,fingerprint,serialized,'accepted',now,now);
    } catch(error) {lease.release();throw error;}
    const controller=new AbortController(),entry={controller,lease,promise:null};this.active.set(id,entry);
    // Persist before acknowledging. Admission slots are reserved synchronously.
    entry.promise=new Promise(resolve=>setImmediate(resolve)).then(()=>this.run(id,job,key,entry));
    entry.promise.catch(()=>console.error('[MEDIA] Failed to persist media job outcome'));
    return this.public(this.get(id,key));
  }
  async run(id,job,key,entry) {
    let timedOut=false;
    const directory=path.join(this.directory,id),signal=entry.controller.signal;
    const timeout=setTimeout(()=>{timedOut=true;entry.controller.abort();},this.timeoutMs);
    const authorized=()=>this.store.keys().some(k=>k.id===key.id && k.enabled && k.providers.includes(this.provider));
    // Revocation cancels background work; rotating a key preserves its identity.
    const revocation=setInterval(()=>{if(!authorized())entry.controller.abort();},1000);
    try {
      if(signal.aborted || !authorized())throw new MediaError('cancelled','Media job cancelled',409);
      fs.mkdirSync(directory,{mode:0o700});
      this.update(id,'generating');
      entry.requestId=this.store.begin({keyId:key.id,accountId:entry.lease.account.id,provider:this.provider,model:job.model});
      const media=await this.process(id,job,entry,directory);
      this.finishGeneration(entry);
      if(signal.aborted || !authorized())throw new MediaError('cancelled','Media job cancelled',409);
      this.update(id,'completed',{media});
    } catch(error) {
      if(entry.requestId)this.store.finish(entry.requestId,error.status || 502,signal.aborted?'disconnected':this.kind+'_generation_failed');
      this.update(id,signal.aborted?(timedOut?'failed':'cancelled'):'failed',
        {errorCode:timedOut?this.kind+'_timeout':signal.aborted?'cancelled':error instanceof MediaError?error.code:this.kind+'_failed'});
      fs.rmSync(directory,{recursive:true,force:true});
    } finally {clearTimeout(timeout);clearInterval(revocation);entry.lease.release();this.active.delete(id);}
  }
  finishGeneration(entry) {
    if(entry.requestId) {this.store.finish(entry.requestId,200,'completed');entry.requestId=null;}
    entry.lease.release();
  }
  cancel(id,key) {
    const row=this.get(id,key);
    if(this.active.has(id))this.active.get(id).controller.abort();
    else if(row.status==='completed')throw new MediaError('already_completed','Completed media cannot be cancelled',409);
    return this.public(this.get(id,key));
  }
  diskUsage(id) {
    const dir=path.join(this.directory,id);if(!fs.existsSync(dir))return 0;
    return fs.readdirSync(dir).reduce((sum,name)=>sum+fs.lstatSync(path.join(dir,name)).size,0);
  }
  prune() {
    const expired=this.store.db.prepare(`SELECT id FROM ${this.table} WHERE createdAt<? AND status IN ('completed','failed','interrupted','cancelled')`).all(Date.now()-this.retentionMs);
    for(const {id} of expired) {fs.rmSync(path.join(this.directory,id),{recursive:true,force:true});this.store.db.prepare(`DELETE FROM ${this.table} WHERE id=?`).run(id);}
  }
  async close() {
    this.accepting=false;
    for(const entry of this.active.values())entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(entry=>entry.promise));
  }
}
module.exports={MediaJobs,TERMINAL};
