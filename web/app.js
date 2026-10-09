'use strict';
const $ = selector => document.querySelector(selector);
let state, editing;
const node = (tag,text,cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e; };
const button = (text,fn,cls) => {const e=node('button',text,cls);e.type='button';e.onclick=async()=>{e.disabled=true;try{await fn();}catch(error){notice(error.message);}finally{e.disabled=false;}};return e;};
function notice(message) { $('#notice').textContent=message;$('#notice').hidden=!message; }
async function api(url,method='GET',body) {
  const response=await fetch(url,{method,headers:method==='GET'?{}:{'content-type':'application/json','x-proxy-admin':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error?.message || 'Request failed');return value;
}
function time(value){return value?new Date(value).toLocaleString():'Not available';}
async function refresh(){try{state=await api('/admin/status');render();notice('');}catch(error){notice('Console disconnected: '+error.message);}}
function render(){
  $('#version').textContent='v'+state.version;
  $('#summary').replaceChildren();
  for(const [label,value] of [['Requests in flight',`${state.pool.active} / ${state.pool.limit}`],['Anthropic accounts',state.accounts.filter(a=>a.provider==='anthropic'&&a.enabled).length],['Gemini accounts',state.accounts.filter(a=>a.provider==='gemini'&&a.enabled).length],['Active API keys',state.keys.filter(k=>k.enabled).length]]){const c=node('div',undefined,'card');c.append(node('span',label),node('strong',value));$('#summary').append(c);}
  $('#listeners').replaceChildren(...[['API',state.inference],['Console',state.console]].map(([label,a])=>node('span',`${label} · ${a?.address}:${a?.port}`)),node('span',`Sticky rotation · ${state.pool.stickyUsageThreshold ?? 95}%`),node('span',`Idle timeout · ${Math.round(state.idleTimeoutMs/60000)} min`),node('span',`Uptime · ${Math.floor(state.uptimeSeconds/60)} min`));
  $('#account-list').replaceChildren();
  for(const login of state.logins||[]){const c=node('article',undefined,'account');c.append(node('h3',login.name),node('p','Connection in progress · '+login.status.replaceAll('_',' '),'muted'),button('Resume login',()=>openLogin(login)));$('#account-list').append(c);}

  for(const a of state.accounts){
    const c=node('article',undefined,'account'),head=node('div',undefined,'account-header');
    const status=state.logins?.some(l=>l.accountId===a.id)?'Reconnecting':a.authStatus==='login_required'?'Login required':!a.enabled?'Disabled':a.cooldownUntil>Date.now()?'Cooling down':'Enabled';
    head.append(node('h3',a.name),node('span',a.provider+' · '+status,'tag'+(status==='Enabled'?'':' off')));c.append(head,node('p',a.credentialsPath,'path'));
    if(a.provider==='anthropic'){
      for(const [field,label] of [['five_hour','5-hour subscription window'],['seven_day','7-day subscription window']]){
        const q=a.quota?.[field],row=node('div',undefined,'quota'),labelRow=node('div',undefined,'quota-label');labelRow.append(node('span',label),node('b',q?`${q.utilization.toFixed(1)}%`:'Unknown'));row.append(labelRow);
        if(q){const progress=node('progress');progress.max=100;progress.value=q.utilization;progress.setAttribute('aria-label',label);row.append(progress,node('small','Resets '+time(q.resets_at)));}c.append(row);
      }
      const stale=!a.quotaUpdatedAt || Date.now()-a.quotaUpdatedAt>300000;
      c.append(node('p',(stale?'Stale / unavailable — excluded from routing. ':'Cloud quota · ')+time(a.quotaUpdatedAt),'muted'));
      if(a.quotaError)c.append(node('p',a.quotaError,'muted'));
    }else {
      c.append(node('p','Cloud project: '+a.project,'muted'));
      const buckets=a.quota?.buckets||[];
      for(const b of buckets)c.append(node('p',`${b.modelId}: ${(b.remainingFraction*100).toFixed(1)}% remaining · resets ${time(b.resetTime)}`,'muted'));
      c.append(node('p',buckets.length?'Cloud quota updated '+time(a.quotaUpdatedAt):'Cloud quota unavailable. No 5-hour / 7-day windows or estimated percentages.','muted'));
      if(a.quotaError)c.append(node('p',a.quotaError,'muted'));
    }
    if(a.cooldownUntil>Date.now())c.append(node('p','Cooldown until '+time(a.cooldownUntil),'muted'));
    c.append(node('p',`In flight: ${state.pool.byAccount[a.id]||0} / ${a.maxConcurrent}`,'muted'));
    const actions=node('div',undefined,'actions');actions.append(button('Edit',()=>edit('accounts',a)),button(a.enabled?'Disable':'Enable',async()=>{await api('/admin/accounts/'+a.id,'PATCH',{enabled:!a.enabled});await refresh();}));
    actions.append(button('Refresh quota',async()=>{await api('/admin/accounts/'+a.id+'/refresh','POST');await refresh();}));
    if(a.provider==='anthropic')actions.append(button('Reconnect',async()=>{openLogin(await api('/admin/accounts/'+a.id+'/reconnect','POST'));await refresh();}));
    actions.append(button('History',()=>history(a)),button('Delete',()=>remove('accounts',a),'danger'));c.append(actions);$('#account-list').append(c);
  }
  if(!state.accounts.length)$('#account-list').append(node('div','Add an account to its provider pool. No credentials are imported automatically.','empty'));
  $('#key-list').replaceChildren();$('#no-keys').hidden=state.keys.length>0;
  for(const k of state.keys){const row=node('tr');const name=node('td');name.append(node('b',k.app),node('div',k.name+' · '+k.prefix+'…','muted'));row.append(name,node('td',k.providers.join(', ')),node('td',k.sourceIps.join(', ')||'Any source'),node('td',`${state.pool.byKey[k.id]||0} / ${k.maxConcurrent}`),node('td',k.enabled?'Enabled':'Disabled'));const actions=node('td');actions.append(button('Edit',()=>edit('keys',k)),button('Rotate',async()=>{if(!confirm('Invalidate the current key and generate a replacement?'))return;showSecret((await api('/admin/keys/'+k.id+'/rotate','POST')).secret);await refresh();}),button('Delete',()=>remove('keys',k),'danger'));row.append(actions);$('#key-list').append(row);}
  renderTraffic();
}
function renderTraffic(){if(!state)return;const rows=state[$('#window').value];$('#traffic-list').replaceChildren();$('#no-traffic').hidden=rows.length>0;for(const r of rows){const row=node('tr');for(const value of [state.keys.find(k=>k.id===r.keyId)?.app||'Deleted key',state.accounts.find(a=>a.id===r.accountId)?.name||'Deleted account',r.provider,r.requests,r.completed,r.disconnected,r.averageDurationMs==null?'In progress':(r.averageDurationMs/1000).toFixed(1)+'s'])row.append(node('td',String(value)));$('#traffic-list').append(row);}}
async function remove(kind,item){if(!confirm(`Delete ${item.name}? Historical traffic remains available.`))return;await api(`/admin/${kind}/${item.id}`,'DELETE');await refresh();}
function field(name,label,value,type='text'){const l=node('label',label);l.htmlFor='field-'+name;const e=node('input');e.id='field-'+name;e.name=name;e.type=type;if(type==='checkbox')e.checked=!!value;else e.value=value??'';if(type==='number'){e.min=1;e.max=10000;}$('#fields').append(l,e);return e;}
function edit(kind,item={}){
  editing={kind,id:item.id};$('#fields').replaceChildren();$('#form-error').textContent='';$('#edit-title').textContent=(item.id?'Edit ':'Create ')+(kind==='keys'?'API key':'account');
  field('name','Name',item.name).required=true;
  if(kind==='keys'){field('app','Application',item.app).required=true;field('providers','Allowed APIs (anthropic, gemini)',(item.providers||['anthropic','gemini']).join(', '));field('sourceIps','Allowed source IPs / CIDRs (comma-separated; empty = any)',(item.sourceIps||[]).join(', '));}
  else{const l=node('label','Provider');l.htmlFor='field-provider';const select=node('select');select.id='field-provider';select.name='provider';for(const provider of ['anthropic','gemini']){const o=node('option',provider);o.value=provider;select.append(o);}select.value=item.provider||'anthropic';$('#fields').append(l,select);field('credentialsPath','Absolute credential file path on proxy host',item.credentialsPath).required=true;field('project','Gemini cloud project (required for Gemini)',item.project);$('#fields').append(node('p','Register a separate OAuth credential file for each account. The console never displays token contents.','muted'));}
  field('maxConcurrent','Maximum concurrent requests',item.maxConcurrent||(kind==='keys'?4:2),'number');field('enabled','Enabled',item.enabled!==false,'checkbox');$('#editor').showModal();
}
$('#edit-form').onsubmit=async event=>{event.preventDefault();const f=new FormData(event.target),body=Object.fromEntries(f);body.enabled=f.has('enabled');body.maxConcurrent=Number(body.maxConcurrent);if(editing.kind==='keys')for(const name of ['providers','sourceIps'])body[name]=body[name].split(',').map(s=>s.trim()).filter(Boolean);const save=event.submitter;save.disabled=true;try{const value=await api('/admin/'+editing.kind+(editing.id?'/'+editing.id:''),editing.id?'PATCH':'POST',body);$('#editor').close();if(value.secret)showSecret(value.secret);await refresh();}catch(error){$('#form-error').textContent=error.message;}finally{save.disabled=false;}};
function showSecret(secret){$('#secret').value=secret;$('#secret-dialog').showModal();}
$('#copy-secret').onclick=async()=>{try{await navigator.clipboard.writeText($('#secret').value);$('#copy-secret').textContent='Copied';}catch(_){$('#secret').focus();$('#secret').select();document.execCommand('copy');}};
$('#close-secret').onclick=()=>{$('#secret').value='';$('#copy-secret').textContent='Copy key';$('#secret-dialog').close();};
$('#secret-dialog').addEventListener('close',()=>{$('#secret').value='';});
$('#close-editor').onclick=()=>$('#editor').close();$('#add-key').onclick=()=>edit('keys');$('#add-account').onclick=()=>edit('accounts');$('#refresh').onclick=refresh;$('#window').onchange=renderTraffic;
refresh();setInterval(()=>{if(!document.hidden)refresh();},15000);

async function history(account) {
  const samples=await api('/admin/accounts/'+account.id+'/usage');$('#history-list').replaceChildren();
  for(const s of samples){const row=node('tr');let summary;
    if(account.provider==='anthropic')summary=`5h: ${s.quota.five_hour?.utilization??'—'}% · 7d: ${s.quota.seven_day?.utilization??'—'}%`;
    else summary=(s.quota.buckets||[]).map(b=>`${b.modelId}: ${(b.remainingFraction*100).toFixed(1)}% remaining`).join('; ');
    row.append(node('td',time(s.at)),node('td',summary));$('#history-list').append(row);
  }
  $('#history-dialog').showModal();
}
$('#close-history').onclick=()=>$('#history-dialog').close();

let loginSession=null, loginTimer;
const loginDone=new Set(['complete','failed','cancelled','expired']);
function openLogin(session=null){
  clearTimeout(loginTimer);loginSession=session;
  $('#login-error').textContent='';$('#login-code').value='';
  $('#login-start').hidden=!!session;$('#login-progress').hidden=!session;
  if(!session){$('#login-name').value='';$('#login-concurrency').value=2;}
  if(!$('#login-dialog').open)$('#login-dialog').showModal();
  if(session){renderLogin(session);scheduleLoginPoll();}
}
function renderLogin(s){
  loginSession=s;
  const labels={starting:'Preparing isolated login…',awaiting_login:'Open the sign-in link and choose the subscription account.',authorizing:'Completing authorization…',verifying:'Checking subscription usage with Anthropic…'};
  $('#login-status').textContent=s.message||labels[s.status]||s.status;
  $('#login-expiry').textContent=loginDone.has(s.status)?'':'Finish before '+time(s.expiresAt)+'. Closing this dialog keeps the login available under Account pools.';
  $('#login-link').hidden=!s.authorizationUrl;
  if(s.authorizationUrl)$('#login-link').href=s.authorizationUrl;else $('#login-link').removeAttribute('href');
  $('#login-code-form').hidden=s.status!=='awaiting_login';
  $('#retry-login').hidden=s.status!=='verification_failed';
  $('#cancel-login').hidden=loginDone.has(s.status);
}
function scheduleLoginPoll(){
  clearTimeout(loginTimer);
  if(!loginSession||loginDone.has(loginSession.status)||!$('#login-dialog').open)return;
  loginTimer=setTimeout(async()=>{const id=loginSession.id;try{const s=await api('/admin/logins/'+id);if(loginSession?.id!==id||!$('#login-dialog').open)return;renderLogin(s);if(loginDone.has(s.status))await refresh();}catch(e){$('#login-error').textContent=e.message;}finally{scheduleLoginPoll();}},1200);
}
$('#connect-account').onclick=()=>openLogin();
$('#login-start').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('#login-error').textContent='';try{const s=await api('/admin/logins','POST',{name:$('#login-name').value,maxConcurrent:Number($('#login-concurrency').value)});openLogin(s);await refresh();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}};
$('#login-code-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('#login-error').textContent='';const code=$('#login-code').value;$('#login-code').value='';try{renderLogin(await api('/admin/logins/'+loginSession.id+'/code','POST',{code}));scheduleLoginPoll();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}};
$('#retry-login').onclick=async()=>{const b=$('#retry-login');b.disabled=true;$('#login-error').textContent='';try{renderLogin(await api('/admin/logins/'+loginSession.id+'/verify','POST'));scheduleLoginPoll();}catch(e){$('#login-error').textContent=e.message;}finally{b.disabled=false;}};
$('#cancel-login').onclick=async()=>{const b=$('#cancel-login');b.disabled=true;try{renderLogin(await api('/admin/logins/'+loginSession.id,'DELETE'));clearTimeout(loginTimer);await refresh();}catch(e){$('#login-error').textContent=e.message;}finally{b.disabled=false;}};
$('#close-login').onclick=()=>$('#login-dialog').close();
$('#login-dialog').addEventListener('close',()=>{clearTimeout(loginTimer);$('#login-code').value='';$('#login-link').removeAttribute('href');loginSession=null;});
