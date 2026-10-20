// Recommendations are explicit operator policy, never inferred by sorting model IDs.
const DEFAULTS = [
  ['anthropic','fable','claude-fable-5-1'],
  ['anthropic','opus','claude-opus-5-5'],
  ['anthropic','sonnet','claude-sonnet-5-5'],
  ['anthropic','haiku','claude-haiku-5-5'],
  ['gemini','gemini','gemini-3.8-flash-medium'],
  ['gemini','argon','gemini-4-argon-medium'],
];
function fail(message,status=400) { throw Object.assign(new Error(message),{status}); }
function validate(row) {
  if (!row || !['anthropic','gemini'].includes(row.provider) ||
      typeof row.family !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(row.family) ||
      typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,199}$/.test(row.id) ||
      !row.id.startsWith(row.provider === 'anthropic' ? 'claude-' : 'gemini-') || row.id.endsWith('-latest')) {
    fail('Expected provider, family and a concrete model ID for that provider');
  }
  return {provider:row.provider,family:row.family,id:row.id};
}
class Catalog {
  constructor(store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_recommendations (
      provider TEXT NOT NULL, family TEXT NOT NULL, model TEXT NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(provider,family));`);
    const insert=store.db.prepare('INSERT OR IGNORE INTO model_recommendations VALUES(?,?,?,?)');
    for(const [provider,family,id] of DEFAULTS) insert.run(provider,family,id,Date.parse('2026-10-20T00:00:00Z'));
  }
  save(input) {
    const r=validate(input);
    this.store.db.prepare(`INSERT INTO model_recommendations VALUES(?,?,?,?) ON CONFLICT(provider,family)
      DO UPDATE SET model=excluded.model,updatedAt=excluded.updatedAt`).run(r.provider,r.family,r.id,Date.now());
    this.store.audit('catalog.update',r.provider+'/'+r.family);
    return this.list([r.provider]).find(m=>m.family===r.family && m.recommended);
  }
  list(providers) {
    const rows=this.store.db.prepare('SELECT * FROM model_recommendations ORDER BY provider,family').all();
    const accounts=this.store.accounts().filter(a=>a.enabled && a.provider==='gemini' && Date.now()-a.quotaUpdatedAt<300000);
    const observed=new Set(accounts.flatMap(a=>(a.quota?.buckets||[]).map(b=>b.modelId)).filter(id=>/^gemini-[a-z0-9.-]+$/.test(id)));
    const data=rows.filter(r=>providers.includes(r.provider)).map(r=>({id:r.model,object:'model',provider:r.provider,family:r.family,
      alias:r.family+'-latest',recommended:true,source:'curated',updated_at:new Date(r.updatedAt).toISOString(),
      availability:r.provider==='gemini' && observed.size ? (observed.has(r.model)?'observed':'not_observed'):'unknown'}));
    if(providers.includes('gemini')) for(const id of observed) if(!data.some(m=>m.provider==='gemini'&&m.id===id))
      data.push({id,object:'model',provider:'gemini',family:id.includes('argon')?'argon':'gemini',recommended:false,source:'cloud',availability:'observed'});
    return data;
  }
  latest(provider,family,providers) {
    if(!provider || !family) fail('provider and family are required');
    if(!['anthropic','gemini'].includes(provider)) fail('Unknown provider');
    if(!providers.includes(provider)) fail('API key does not allow this provider',403);
    const row=this.list(providers).find(m=>m.provider===provider&&m.family===family&&m.recommended);
    if(!row) fail('No recommendation configured for this model family',404);
    if(row.availability==='not_observed') fail('Recommended model is absent from the current cloud catalog; update the recommendation',503);
    return {...row,resolved_at:new Date().toISOString()};
  }
  resolve(id,providers,expectedProvider) {
    const prefix=/^(anthropic|google|gemini)\//.exec(id)?.[1];
    const prefixProvider=prefix==='anthropic'?'anthropic':prefix?'gemini':undefined;
    if(prefixProvider && expectedProvider && prefixProvider!==expectedProvider) fail('Model alias provider does not match endpoint');
    expectedProvider=expectedProvider || prefixProvider;
    const normalized=id.replace(/^(anthropic|google|gemini)\//,'');
    if(!normalized.endsWith('-latest')) return id;
    let family=normalized.slice(0,-7).replace(/^claude-/,'');
    if(family==='gemini-argon') family='argon';
    const recommendations=this.list(['anthropic','gemini']).filter(r=>r.recommended&&r.family===family&&(!expectedProvider||r.provider===expectedProvider));
    if(recommendations.length!==1) fail('Unknown or ambiguous model alias',404);
    return this.latest(recommendations[0].provider,family,providers).id;
  }
}
module.exports={Catalog,validate};
