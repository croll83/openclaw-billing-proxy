const test=require('node:test');
const assert=require('node:assert/strict');
const {googleQuota}=require('../web/quota');
test('Google quota view uses explicit cloud groups and excludes third-party models without merging equal values',()=>{
 const q={groups:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-5h',remainingFraction:.5,window:'5h'},{bucketId:'gemini-weekly',remainingFraction:.7,window:'weekly'}]},{displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',remainingFraction:.5,window:'weekly'}]},{displayName:'Claude and GPT',buckets:[{bucketId:'3p-5h',remainingFraction:1}]}],buckets:['gemini-4-argon-medium','claude-sonnet-5-5','gpt-oss-120b','tab_flash','gemini-3.8-flash-medium'].map(modelId=>({modelId,remainingFraction:.5}))};
 const view=googleQuota(q);assert.equal(view.groups.length,2);assert.equal(view.groups[0].buckets.length,2);assert.equal(view.groups[1].buckets[0].remainingFraction,.5);assert.equal(view.models.length,2);assert.ok(view.models.every(m=>m.modelId.startsWith('gemini-')));
 assert.equal(q.groups.length,3,'Raw provider data remains intact for routing');
});
test('missing cloud groups never invent account percentages from model allowances',()=>{
 const view=googleQuota({buckets:[{modelId:'gemini-test',remainingFraction:.4},{modelId:'gemini-invalid',remainingFraction:4}]});assert.deepEqual(view.groups,[]);assert.equal(view.models.length,1);
});
