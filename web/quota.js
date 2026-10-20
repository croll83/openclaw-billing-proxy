// Display the provider's explicit groups. Never sum model percentages or infer
// shared pools from matching remaining fractions/reset timestamps.
(function(root){
  function googleQuota(quota={}) {
    const valid=b=>Number.isFinite(b.remainingFraction)&&b.remainingFraction>=0&&b.remainingFraction<=1;
    const groups=(quota.groups||[]).map(g=>({name:g.displayName,buckets:(g.buckets||[]).filter(b=>/^gemini(?:-|$)/i.test(b.bucketId||'')&&valid(b))})).filter(g=>g.buckets.length);
    const models=(quota.buckets||[]).filter(b=>/^gemini-[a-z0-9.-]+$/.test(b.modelId)&&valid(b)).sort((a,b)=>a.modelId.localeCompare(b.modelId));
    return {groups,models};
  }
  if(typeof module==='object'&&module.exports)module.exports={googleQuota};
  else root.googleQuota=googleQuota;
})(globalThis);
