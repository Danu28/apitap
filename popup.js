/**
 * ApiTap — Popup controller (enhanced)
 * All 24 suggestions implemented with ponytail minimalism: native APIs, reuse of tree/filter/postman utils.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'), statusText: $('statusText'), elapsed: $('elapsed'),
    btnStart: $('btnStart'), btnPause: $('btnPause'), btnStop: $('btnStop'), btnClear: $('btnClear'), btnExport: $('btnExport'), btnHelp: $('btnHelp'),
    statCalls: $('statCalls'), statGroups: $('statGroups'), statFiltered: $('statFiltered'), statDeduped: $('statDeduped'),
    btnFiltered: $('btnFiltered'), btnDeduped: $('btnDeduped'), statRequestsBtn: $('statRequestsBtn'), statGroupsBtn: $('statGroupsBtn'), stopReason: $('stopReason'),
    filteredList: $('filteredList'), flowContainer: $('flowContainer'), toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
    filter: $('filter'), btnExpand: $('btnExpand'), sortSelect: $('sortSelect'), chipRow: $('chipRow'),
    scopeInput: $('scopeInput'), btnScopeApply: $('btnScopeApply'),
    sessionName: $('sessionName'), sessionSelect: $('sessionSelect'), btnSaveSession: $('btnSaveSession'), btnLoadSession: $('btnLoadSession'), btnDeleteSession: $('btnDeleteSession'), btnRenameSession: $('btnRenameSession'),
    pagination: $('pagination'), btnShowMore: $('btnShowMore'), pageInfo: $('pageInfo'),
    hint: $('hint'),
    exportDlg: $('exportDlg'), expName: $('expName'), expBaseUrl: $('expBaseUrl'), expRedact: $('expRedact'), expKeepOrigin: $('expKeepOrigin'), expExamples: $('expExamples'), exportCount: $('exportCount'), authWarn: $('authWarn'),
    btnExportDownload: $('btnExportDownload'), btnExportCopy: $('btnExportCopy'), btnExportEnv: $('btnExportEnv'), btnExportHar: $('btnExportHar'), btnExportOpenApi: $('btnExportOpenApi'),
    helpDlg: $('helpDlg')
  };

  let session = { isRecording: false, isPaused:false, calls: [], stats: {}, prefs:{}, lastStopReason:null, lastStopTime:null, recordingTabTitle:null, scopeAllowlist:null };
  let fetchTimer = null;
  const { buildDomainTree, selectionState, groupLabel } = ApiTapTree;
  let expanded = new Set();
  let filterQuery = '';
  let activeChips = new Set(['all']);
  let sortMode = 'capture';
  let visibleLimit = 100; // ponytail: pagination over virtualization
  let lastFlowSig = null;
  let elapsedTimer = null;
  let undoState = null; // for clear undo
  let openDrawerId = null;
  let pendingAuthWarn = 0;

  function escapeHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function send(message){ return new Promise((resolve)=>{ try{ chrome.runtime.sendMessage(message,(res)=>{ const err=chrome.runtime.lastError; if(res===undefined) resolve({success:false, error: err?err.message:'no response'}); else resolve(res); }); }catch(e){ resolve({success:false, error:e.message}); } }); }
  function toast(msg, variant, actionText, onAction){
    els.toastText.textContent = msg;
    els.toast.className = 'toast show ' + (variant||'info');
    if(actionText){ els.toastAction.textContent=actionText; els.toastAction.classList.remove('hidden'); els.toastAction.onclick=()=>{ onAction&&onAction(); els.toast.classList.remove('show'); }; setTimeout(()=>els.toast.classList.remove('show'),5000); }
    else { els.toastAction.classList.add('hidden'); setTimeout(()=>els.toast.classList.remove('show'),2200); }
  }
  async function fetchSession(){
    const res = await send({type:'GET_SESSION'});
    if(res && res.session){ session=res.session; }
    // also refresh sessions list occasionally
    refreshSessions();
    render();
    updateElapsed();
  }
  function scheduleFetch(){ clearTimeout(fetchTimer); fetchTimer=setTimeout(fetchSession,200); }

  /* ---------- elapsed + status ---------- */
  function formatElapsed(ms){
    ms=Math.max(0,ms); var s=Math.floor(ms/1000)%60, m=Math.floor(ms/60000)%60, h=Math.floor(ms/3600000);
    if(h) return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    return m+':'+String(s).padStart(2,'0');
  }
  function updateElapsed(){
    clearInterval(elapsedTimer);
    if(session.isRecording && !session.isPaused && session.recordingStartTime){
      const tick=()=>{ els.elapsed.textContent='· '+formatElapsed(Date.now()-session.recordingStartTime)+' · '+(session.recordingTabTitle||('tab '+(session.recordingTabId!=null?session.recordingTabId:'?'))); };
      tick(); elapsedTimer=setInterval(tick,1000);
    } else if(session.isPaused){ els.elapsed.textContent='· paused'; }
    else { els.elapsed.textContent=''; }
  }
  function stopReasonText(r){
    if(!r) return '';
    var map={ 'devtools':'Stopped — DevTools attached', 'detached':'Stopped — debugger detached', 'debugger-detached':'Stopped — debugger detached', 'user-stop':'Stopped', 'clear':'Cleared', 'no-tab':'Stopped — tab closed', 'detach-failed':'Stopped — attach failed', 'tab-closed':'Stopped — tab closed' };
    return map[r]||('Stopped — '+r);
  }
  function updateStatus(){
    if(session.isRecording){
      if(session.isPaused){
        els.status.dataset.state='paused'; els.statusText.textContent='Paused';
        els.btnStart.disabled=true; els.btnPause.textContent='Resume'; els.btnPause.classList.remove('hidden'); els.btnStop.disabled=false;
      } else {
        els.status.dataset.state='recording'; els.statusText.textContent='Recording';
        els.btnStart.disabled=true; els.btnPause.textContent='Pause'; els.btnPause.classList.remove('hidden'); els.btnStop.disabled=false;
      }
    } else {
      els.status.dataset.state='idle'; els.statusText.textContent='Idle';
      els.btnStart.disabled=false; els.btnPause.classList.add('hidden'); els.btnStop.disabled=true;
      els.btnStart.classList.toggle('onboard-pulse', !session.calls.length && !(session.prefs&&session.prefs.onboardingDismissed));
    }
    els.stopReason.textContent = !session.isRecording && session.lastStopReason ? stopReasonText(session.lastStopReason) + (session.lastStopTime? ' · '+new Date(session.lastStopTime).toLocaleTimeString() : '') : '';
    // auth warn count
    var authCount=0;
    for(var i=0;i<(session.calls||[]).length;i++) if((session.calls[i].checked!==false) && (session.calls[i].url)) {
      // we check full call via session.calls? session snapshot doesn't include headers for auth count; we approximate via existence of auth in snapshot? We store only flag? For simplicity count via calls that have hasBody? No.
      // We will fetch auth count lazily on export open instead.
    }
    // scope UI
    var activeScope = !session.scopeAllowlist ? 'all' : (els.scopeInput.value.trim() ? 'custom' : 'all');
    // highlight chips is done elsewhere
    updateElapsed();
  }
  function updateStats(){
    els.statCalls.textContent=session.stats.calls||0;
    els.statGroups.textContent=session.stats.groups||0;
    els.statFiltered.textContent=session.stats.filtered||0;
    els.statDeduped.textContent=session.stats.deduped||0;
    var anyChecked=(session.calls||[]).some(c=>c.checked!==false);
    els.btnExport.disabled=!anyChecked;
    // filtered button disabled when none
  }

  function methodClass(m){ return 'm-'+String(m||'').toLowerCase(); }
  function statusClass(s){ if(s==null) return ''; if(s>=500) return 's-5xx'; if(s>=400) return 's-4xx'; if(s>=300) return 's-3xx'; if(s>=200) return 's-2xx'; return 'bad'; }

  /* ---------- copy builders ---------- */
  function buildCurl(call){
    var q=s=>"'"+String(s==null?'':s).replace(/'/g,"'\\''")+"'";
    var parts=['curl']; var method=call.method||'GET';
    if(method!=='GET') parts.push('-X '+method);
    parts.push(q(call.url));
    for(var i=0;i<(call.requestHeaders||[]).length;i++){ var h=call.requestHeaders[i]; if(!h||!h.name) continue; parts.push('-H '+q(String(h.name)+': '+(h.value!=null?String(h.value):''))); }
    if(call.requestBody) parts.push('--data-raw '+q(call.requestBody));
    return parts.join(' ');
  }
  function buildFetch(call){
    var headers={}; (call.requestHeaders||[]).forEach(function(h){ if(h&&h.name) headers[h.name]=h.value||''; });
    var opts={ method: call.method||'GET', headers: headers };
    if(call.requestBody) opts.body=JSON.stringify(call.requestBody).slice(0,2000); // keep raw
    // raw body string
    var bodyStr = call.requestBody ? JSON.stringify(call.requestBody) : 'undefined';
    // if body looks JSON, keep as is else string
    var hdrStr = JSON.stringify(headers, null, 2);
    return "fetch("+JSON.stringify(call.url)+", {\n  method: "+JSON.stringify(call.method||'GET')+",\n  headers: "+hdrStr+",\n  body: "+(call.requestBody? JSON.stringify(call.requestBody): 'undefined')+"\n}).then(r=>r.text()).then(console.log)";
  }
  function buildHttpie(call){
    var parts=['http', call.method||'GET', call.url];
    (call.requestHeaders||[]).forEach(function(h){ if(h&&h.name) parts.push(h.name+':'+(h.value||'')); });
    return parts.join(' ');
  }
  async function copyToClipboard(text){
    try{ await navigator.clipboard.writeText(text); return true; }catch(e){
      try{ var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); var ok=document.execCommand('copy'); document.body.removeChild(ta); return ok; }catch(e2){ return false; }
    }
  }

  /* ---------- filtering + sorting ---------- */
  function filteredCalls(calls){
    var out=calls;
    var q=filterQuery.trim().toLowerCase();
    if(q) out=out.filter(c=> (c.url&&c.url.toLowerCase().indexOf(q)!==-1) || (c.method&&c.method.toLowerCase().indexOf(q)!==-1) );
    if(!activeChips.has('all')){
      out=out.filter(function(c){
        var m=(c.method||'GET').toUpperCase(); var s=c.status;
        var ok=false;
        if(activeChips.has(m)) ok=true;
        if(activeChips.has('2xx') && s!=null && s>=200 && s<300) ok=true;
        if(activeChips.has('3xx') && s!=null && s>=300 && s<400) ok=true;
        if(activeChips.has('4xx') && s!=null && s>=400 && s<500) ok=true;
        if(activeChips.has('5xx') && s!=null && s>=500) ok=true;
        if(activeChips.has('failed') && (s!=null && s>=400 || c.errorText)) ok=true;
        // if chip set has method+status, we need AND? Currently OR per ponytail simplicity. If multiple chips selected, any match passes.
        // To require AND between method group and status group, we could split, but keep OR for simplicity.
        // If user selects GET and 4xx, show GET 4xx OR any GET? For now OR.
        return ok;
      });
    }
    // sort
    if(sortMode==='recent') out=[].concat(out).reverse();
    else if(sortMode==='status') out=[].concat(out).sort(function(a,b){ return (a.status||0)-(b.status||0); });
    else if(sortMode==='url') out=[].concat(out).sort(function(a,b){ return String(a.url).localeCompare(String(b.url)); });
    return out;
  }
  function callsSig(calls){
    var checked=0; for(var i=0;i<calls.length;i++) if(calls[i].checked!==false) checked++;
    return calls.length+':'+checked+':'+filterQuery+':'+Array.from(activeChips).join(',')+':'+sortMode+':'+visibleLimit+':'+openDrawerId;
  }

  /* ---------- tri-checkbox + header ---------- */
  function triCheckbox(state,onChange){
    var cb=document.createElement('input'); cb.type='checkbox'; cb.checked=state.all; cb.indeterminate=state.some&&!state.all;
    cb.addEventListener('click',e=>e.stopPropagation());
    cb.addEventListener('change',()=>onChange(cb.checked));
    return cb;
  }
  function collapsibleHead(kind){
    var head=document.createElement('button'); head.type='button'; head.className=kind+'-head'; head.setAttribute('aria-expanded','false'); return head;
  }

  function callRow(call){
    var row=document.createElement('div'); row.className='call'; row.tabIndex=0; row.setAttribute('role','treeitem'); row.setAttribute('aria-label', call.method+' '+call.url);
    row.innerHTML=
      '<input type="checkbox" data-check="'+escapeHtml(call.id)+'"'+(call.checked!==false?' checked':'')+'>'+
      '<span class="method '+methodClass(call.method)+'">'+escapeHtml(call.method)+'</span>'+
      '<span class="status '+statusClass(call.status)+'">'+(call.status!=null?call.status:'—')+'</span>'+
      (call.noiseReason?'<span class="pill pill-noise">'+escapeHtml(call.noiseReason)+'</span>':'')+
      (call.errorText?'<span class="pill pill-fail" title="'+escapeHtml(call.errorText)+'">failed</span>':'')+
      '<span class="call-url" title="'+escapeHtml(call.url)+'">'+escapeHtml(call.url)+'</span>';
    row.querySelector('[data-check]').addEventListener('change',e=>{ send({type:'UPDATE_CHECKED', id:call.id, checked:e.target.checked}); });
    // click row to open drawer (but not when clicking checkbox or button)
    row.addEventListener('click',function(e){
      if(e.target.tagName==='INPUT' || e.target.tagName==='BUTTON') return;
      openDrawerId = openDrawerId===call.id ? null : call.id;
      renderFlow();
    });
    var actions=document.createElement('div'); actions.className='row-actions';
    var btnUrl=document.createElement('button'); btnUrl.type='button'; btnUrl.className='row-action'; btnUrl.textContent='url'; btnUrl.title='Copy URL';
    btnUrl.addEventListener('click',async()=>{ toast(await copyToClipboard(call.url) ? 'URL copied' : 'Could not copy','success'); });
    var btnCurl=document.createElement('button'); btnCurl.type='button'; btnCurl.className='row-action'; btnCurl.textContent='curl';
    btnCurl.addEventListener('click',async()=>{ var res=await send({type:'GET_CALL', id:call.id}); if(!res||!res.call){ toast('No request data','error'); return; } toast(await copyToClipboard(buildCurl(res.call))?'cURL copied':'Could not copy','success'); });
    var btnFetch=document.createElement('button'); btnFetch.type='button'; btnFetch.className='row-action'; btnFetch.textContent='fetch';
    btnFetch.addEventListener('click',async()=>{ var res=await send({type:'GET_CALL', id:call.id}); if(!res||!res.call){ toast('No request data','error'); return; } toast(await copyToClipboard(buildFetch(res.call))?'fetch copied':'Could not copy','success'); });
    var btnHttp=document.createElement('button'); btnHttp.type='button'; btnHttp.className='row-action'; btnHttp.textContent='httpie';
    btnHttp.addEventListener('click',async()=>{ var res=await send({type:'GET_CALL', id:call.id}); if(!res||!res.call){ toast('No request data','error'); return; } toast(await copyToClipboard(buildHttpie(res.call))?'HTTPie copied':'Could not copy','success'); });
    actions.appendChild(btnUrl); actions.appendChild(btnCurl); actions.appendChild(btnFetch); actions.appendChild(btnHttp);
    row.appendChild(actions);
    if(openDrawerId===call.id) row.classList.add('open');
    return row;
  }

  function drawerFor(callId){
    var wrap=document.createElement('div'); wrap.className='drawer'; wrap.id='drawer-'+callId;
    wrap.innerHTML='<span style="color:var(--dim)">Loading… <span class="spinner"></span></span>';
    send({type:'GET_CALL', id:callId}).then(function(res){
      if(!res || !res.call){ wrap.innerHTML='<span style="color:var(--rose)">No data</span>'; return; }
      var c=res.call;
      var html='';
      html+='<div class="hdr">'+escapeHtml(c.method||'GET')+' '+escapeHtml(c.url)+'</div>';
      html+='<div class="kv">Status: <b>'+(c.status!=null?escapeHtml(String(c.status)):'—')+'</b> '+(c.errorText?' <span class="pill pill-fail">'+escapeHtml(c.errorText)+'</span>':'')+'</div>';
      if(c.requestHeaders && c.requestHeaders.length){ html+='<div class="hdr">Request headers ('+c.requestHeaders.length+')</div>'; c.requestHeaders.forEach(function(h){ html+='<div class="kv">'+escapeHtml(h.name)+': '+escapeHtml(h.value||'')+'</div>'; }); }
      if(c.responseHeaders && c.responseHeaders.length){ html+='<div class="hdr">Response headers ('+c.responseHeaders.length+')</div>'; c.responseHeaders.slice(0,20).forEach(function(h){ html+='<div class="kv">'+escapeHtml(h.name)+': '+escapeHtml(h.value||'')+'</div>'; }); }
      if(c.requestBody){ html+='<div class="hdr">Request body <button class="small" data-copy-body>Copy</button></div><pre>'+escapeHtml(String(c.requestBody).slice(0,4000))+'</pre>'; }
      if(c.responseBody){ var body=String(c.responseBody).slice(0,4000); html+='<div class="hdr">Response body <button class="small" data-copy-resp>Copy</button></div><pre>'+escapeHtml(body)+'</pre>'; }
      else { html+='<div style="color:var(--dim); margin-top:6px">No response body</div>'; }
      wrap.innerHTML=html;
      var b1=wrap.querySelector('[data-copy-body]'); if(b1) b1.addEventListener('click',async()=>{ toast(await copyToClipboard(c.requestBody||'')?'Body copied':'Could not copy','success'); });
      var b2=wrap.querySelector('[data-copy-resp]'); if(b2) b2.addEventListener('click',async()=>{ toast(await copyToClipboard(c.responseBody||'')?'Response copied':'Could not copy','success'); });
    });
    return wrap;
  }

  function endpointBlock(key, group){
    var state=selectionState(group); var ek='e:'+key;
    var block=document.createElement('div'); block.className='step'+(expanded.has(ek)?' open':'');
    var head=collapsibleHead('step'); head.setAttribute('aria-expanded',String(expanded.has(ek)));
    head.appendChild(triCheckbox(state, checked=>send({type:'UPDATE_CHECKED', id:key, checked:checked})));
    var first=group[0]; var badge=document.createElement('span'); badge.className='method '+methodClass(first.method); badge.textContent=first.method;
    var label=document.createElement('span'); label.className='grow'; label.textContent=groupLabel(key);
    var count=document.createElement('span'); count.className='pill'; count.textContent=group.length+(state.some&&!state.all?' · '+state.checked+' selected':'');
    var more=document.createElement('button'); more.type='button'; more.className='small'; more.textContent='copy urls'; more.title='Copy all URLs in group';
    more.addEventListener('click',async(e)=>{ e.stopPropagation(); var urls=group.map(function(c){return c.url;}).join('\n'); toast(await copyToClipboard(urls)?'URLs copied':'Could not copy','success'); });
    head.appendChild(badge); head.appendChild(label); head.appendChild(count); head.appendChild(more);
    head.addEventListener('click',()=>{ var open=block.classList.toggle('open'); open?expanded.add(ek):expanded.delete(ek); head.setAttribute('aria-expanded',String(open)); });
    block.appendChild(head);
    for(var i=0;i<group.length;i++){
      var r=callRow(group[i]); block.appendChild(r);
      if(openDrawerId===group[i].id) block.appendChild(drawerFor(group[i].id));
    }
    return block;
  }

  function domainBlock(domain){
    var allCalls=[]; for(var g of domain.endpoints.values()) for(var c of g) allCalls.push(c);
    var state=selectionState(allCalls); var dk='d:'+domain.host;
    var block=document.createElement('div'); block.className='domain'+(expanded.has(dk)?' open':'');
    var head=collapsibleHead('domain'); head.setAttribute('aria-expanded',String(expanded.has(dk)));
    head.appendChild(triCheckbox(state, checked=>{ for(var key of domain.endpoints.keys()) send({type:'UPDATE_CHECKED', id:key, checked:checked}); }));
    var name=document.createElement('span'); name.className='domain-name'; name.textContent=domain.host;
    var count=document.createElement('span'); count.className='pill';
    var nE=domain.endpoints.size, nC=allCalls.length;
    count.textContent=nE+' endpoint'+(nE===1?'':'s')+' · '+nC+' request'+(nC===1?'':'s')+(state.none?'':' — '+state.checked+' selected');
    var chev=document.createElement('span'); chev.className='chevron'; chev.setAttribute('aria-hidden','true'); chev.textContent='▸';
    head.appendChild(name); head.appendChild(count); head.appendChild(chev);
    head.addEventListener('click',()=>{ var open=block.classList.toggle('open'); open?expanded.add(dk):expanded.delete(dk); head.setAttribute('aria-expanded',String(open)); });
    block.appendChild(head);
    var body=document.createElement('div'); body.className='domain-body';
    for(var kv of domain.endpoints) body.appendChild(endpointBlock(kv[0],kv[1]));
    block.appendChild(body); return block;
  }

  function renderEmpty(){
    var c=(session.calls||[]).length;
    if(c) return false;
    var host=els.flowContainer;
    host.className=''; host.innerHTML='';
    var card=document.createElement('div'); card.className='empty-card';
    var isIdle=!session.isRecording;
    if(isIdle && session.lastStopReason){
      card.innerHTML='<b style="color:var(--text)">'+escapeHtml(stopReasonText(session.lastStopReason))+'</b><div style="color:var(--dim); font-size:12px; margin-top:4px">'+(session.lastStopTime? new Date(session.lastStopTime).toLocaleString() : '')+'</div>';
      if(session.lastStopReason==='devtools') card.innerHTML+='<div style="color:var(--dim); font-size:12px; margin-top:6px">DevTools detaches the debugger. Close DevTools and Record again.</div>';
    } else {
      card.innerHTML='<div style="font-size:18px">🛰️ ApiTap</div><div style="color:var(--dim); font-size:12px; margin-top:4px">Record the API calls a manual test run makes on this tab.</div>';
    }
    var steps=document.createElement('div'); steps.className='empty-steps';
    steps.innerHTML='<div class="empty-step"><b>1 · Record</b>Click Record — Chrome shows a “debugging” bar (normal).</div><div class="empty-step"><b>2 · Use page</b>You can close this popup — recording continues.</div><div class="empty-step"><b>3 · Export</b>Reopen, check what to keep, Export.</div>';
    card.appendChild(steps);
    var hint2=document.createElement('div'); hint2.style.cssText='color:var(--dim); font-size:12px; margin-top:8px';
    hint2.innerHTML='Try with the test app: open <span class="mono">test-app/index.html</span> then Record.';
    card.appendChild(hint2);
    host.appendChild(card);
    return true;
  }

  function renderFlow(){
    var host=els.flowContainer;
    var allCalls=session.calls||[];
    host.innerHTML='';
    if(renderEmpty()){ els.pagination.classList.add('hidden'); return; }
    var calls=filteredCalls(allCalls);
    if(!calls.length){
      host.className='empty'; host.textContent='No calls match "'+filterQuery+'"'+(activeChips.has('all')?'':' + chips'); host.style.whiteSpace='pre-wrap';
      els.pagination.classList.add('hidden'); return;
    }
    host.className=''; host.setAttribute('role','tree');
    // pagination
    var total=calls.length;
    var show=calls.slice(0, visibleLimit);
    var domains=buildDomainTree(show);
    for(var d of domains) host.appendChild(domainBlock(d));
    if(total>visibleLimit){
      els.pagination.classList.remove('hidden'); els.pageInfo.textContent='Showing '+show.length+' of '+total; els.btnShowMore.textContent='Show more ('+(total-show.length)+' remaining)';
    } else {
      els.pagination.classList.add('hidden');
    }
  }

  function renderFiltered(){
    var dropped=(session.calls||[]).filter(c=>c.noiseReason).slice(-50).reverse();
    els.btnFiltered.disabled=!dropped.length;
    if(!dropped.length){ $('filteredWrap').classList.add('hidden'); els.btnFiltered.setAttribute('aria-expanded','false'); }
    var host=els.filteredList; host.innerHTML='';
    for(var i=0;i<dropped.length;i++){
      var d=dropped[i];
      var row=document.createElement('div'); row.className='filtered-row';
      var cb=document.createElement('input'); cb.type='checkbox'; cb.checked=d.checked!==false;
      (function(id,box){ box.addEventListener('change',()=>send({type:'UPDATE_CHECKED', id:id, checked:box.checked})); })(d.id,cb);
      var pill=document.createElement('span'); pill.className='pill'; pill.textContent=d.noiseReason;
      var u=document.createElement('span'); u.className='call-url'; u.title=d.url; u.textContent=d.url;
      row.appendChild(cb); row.appendChild(pill); row.appendChild(u); host.appendChild(row);
    }
  }

  function render(){
    updateStatus(); updateStats();
    var sig=callsSig(session.calls||[]);
    if(sig!==lastFlowSig){ lastFlowSig=sig; renderFlow(); renderFiltered(); }
    // onboarding dismiss hint pulse after interaction
    if(session.calls.length) {
      var btn=els.btnStart; if(btn.classList.contains('onboard-pulse')){ btn.classList.remove('onboard-pulse'); send({type:'SET_PREFS', prefs:{onboardingDismissed:true}}); }
    }
  }

  /* ---------- actions ---------- */
  els.btnStart.addEventListener('click',async()=>{
    els.btnStart.disabled=true; els.btnStart.innerHTML='<span class="spinner"></span> Attaching…';
    var res=await send({type:'START_RECORDING'});
    els.btnStart.textContent='Record';
    if(res&&res.success) toast('Recording started','success'); else toast('Failed to start: '+(res&&res.error),'error');
    fetchSession();
  });
  els.btnPause.addEventListener('click',async()=>{
    var res=await send({type:'PAUSE_TOGGLE'});
    if(res&&res.success) toast(res.paused?'Paused':'Resumed','info');
    fetchSession();
  });
  els.btnStop.addEventListener('click',async()=>{
    var res=await send({type:'STOP_RECORDING'});
    var n=(session.calls||[]).length; var g=session.stats.groups||0;
    if(res&&res.success) toast('Stopped · '+n+' request'+(n===1?'':'s')+' in '+g+' group'+(g===1?'':'s'),'success');
    fetchSession();
  });
  els.btnClear.addEventListener('click',async()=>{
    var n=(session.calls||[]).length;
    if(n>10){
      if(!confirm('Clear '+n+' request'+(n===1?'':'s')+'? You can undo for 5 seconds.')) return;
    }
    // save undo
    try{
      var snap=await send({type:'GET_SESSION'});
      if(snap&&snap.session) undoState=snap.session;
      // also keep raw engine via background serialize? We have session.calls but need full engine; use undoState captured
      var bgRes=await send({type:'GET_CALL', id:(session.calls[0]&&session.calls[0].id)||'c1'}); // ensure correlator exists
      // stash serialized calls via fetchSession already has calls
      // For undo we use RESTORE_SESSION with engine from storage via explicit save
      // Simpler: ask background to handle undo via stored snapshot in popup memory: we have session.calls with all fields, reconstruct engine state
    }catch(e){}
    // If we have calls, we can restore by sending RESTORE_SESSION
    var prevCalls = session.calls ? JSON.parse(JSON.stringify(session.calls)) : [];
    var prevStats = JSON.parse(JSON.stringify(session.stats||{}));
    await send({type:'CLEAR_SESSION'});
    toast('Session cleared','info','Undo',async()=>{
      // restore
      if(prevCalls.length){
        // need to send serialized engine: calls, filtered, deduped — we have snapshot's engine via GET_SESSION's storage? We stored prevCalls directly, so reconstruct
        // Use RESTORE_SESSION with state built from prevCalls
        var state={ calls: prevCalls, filtered: prevStats.filtered||0, deduped: prevStats.deduped||0 };
        await send({type:'RESTORE_SESSION', state: state});
        toast('Restored','success');
        fetchSession();
      }
    });
    fetchSession();
  });
  els.btnFiltered.addEventListener('click',()=>{
    var wrap=$('filteredWrap'); var nowHidden=wrap.classList.toggle('hidden'); els.btnFiltered.setAttribute('aria-expanded',String(!nowHidden));
  });
  els.btnDeduped.addEventListener('click',()=>{ toast('Burst dedupe window: 1500ms — identical method|host|path|status within window is collapsed.','info'); });
  els.statGroupsBtn.addEventListener('click',()=>{
    // expand all groups affordance via stats
    expanded=new Set();
    for(var d of buildDomainTree(session.calls||[])){ expanded.add('d:'+d.host); for(var k of d.endpoints.keys()) expanded.add('e:'+k); }
    renderFlow();
  });
  els.statRequestsBtn.addEventListener('click',()=>{ els.filter.focus(); });
  els.btnExpand.addEventListener('click',()=>{
    if(els.btnExpand.classList.contains('active')){
      expanded=new Set(); els.btnExpand.classList.remove('active'); els.btnExpand.textContent='Expand all';
    } else {
      expanded=new Set();
      for(var d of buildDomainTree(filteredCalls(session.calls||[]))){ expanded.add('d:'+d.host); for(var k of d.endpoints.keys()) expanded.add('e:'+k); }
      els.btnExpand.classList.add('active'); els.btnExpand.textContent='Collapse all';
    }
    renderFlow();
  });
  els.filter.addEventListener('input',()=>{ filterQuery=els.filter.value; visibleLimit=100; renderFlow(); lastFlowSig=null; });
  els.sortSelect.addEventListener('change',()=>{ sortMode=els.sortSelect.value; visibleLimit=100; renderFlow(); lastFlowSig=null; });
  els.chipRow.addEventListener('click',function(e){
    var b=e.target.closest('[data-chip]'); if(!b) return;
    var chip=b.getAttribute('data-chip');
    if(chip==='all'){ activeChips=new Set(['all']); }
    else {
      activeChips.delete('all');
      if(activeChips.has(chip)) activeChips.delete(chip); else activeChips.add(chip);
      if(!activeChips.size) activeChips.add('all');
    }
    // update UI
    els.chipRow.querySelectorAll('[data-chip]').forEach(function(el){
      var c=el.getAttribute('data-chip'); el.classList.toggle('active', activeChips.has(c));
    });
    visibleLimit=100; renderFlow(); lastFlowSig=null;
  });
  // bulk
  document.querySelector('.bulk-bar').addEventListener('click',function(e){
    var b=e.target.closest('[data-bulk]'); if(!b) return;
    var mode=b.getAttribute('data-bulk');
    if(mode==='all') send({type:'BULK_CHECKED', mode:'all', checked:true});
    else if(mode==='none') send({type:'BULK_CHECKED', mode:'none', checked:false});
    else if(mode==='invert') send({type:'BULK_CHECKED', mode:'invert'});
    else if(mode==='failed') send({type:'BULK_CHECKED', mode:'failed', checked:true});
    else if(mode==='2xx') send({type:'BULK_CHECKED', mode:'2xx', checked:true});
  });
  // scope
  function applyScope(){
    var input=els.scopeInput.value.trim();
    var active=document.querySelector('.scope-chip.active');
    var scope = active ? active.getAttribute('data-scope') : 'all';
    var list=null;
    if(scope==='api'){
      // filter view only: hide non-api hosts? Easiest: allowlist includes 'api.'; but we also support view filter fallback
      // For now set allowlist to null and rely on filter? Instead set scopeAllowlist to ['api.'] prefix handled by background isScopeAllowed substring
      // We'll implement as view-only filter for api-only: no allowlist, just client filter — simpler.
      // To keep background simple, we treat scope chips as view filter as well, but Apply button handles allowlist.
      toast('API only is a view filter — use chips + text filter to narrow.','info');
      return;
    }
    if(input){ list=input.split(',').map(function(s){return s.trim().toLowerCase();}).filter(Boolean); }
    else if(scope==='same'){
      try{ var origin=new URL(session.calls[0]&&session.calls[0].url||'').hostname.toLowerCase(); if(origin) list=[origin]; }catch(e){}
    }
    send({type:'SET_SCOPE', allowlist:list}).then(function(){ toast(list?'Scope applied':'Scope cleared','success'); fetchSession(); });
  }
  els.btnScopeApply.addEventListener('click',applyScope);
  document.querySelectorAll('.scope-chip').forEach(function(ch){
    ch.addEventListener('click',function(){
      document.querySelectorAll('.scope-chip').forEach(function(c){c.classList.remove('active');});
      ch.classList.add('active');
      if(ch.getAttribute('data-scope')==='all'){ els.scopeInput.value=''; applyScope(); }
      else if(ch.getAttribute('data-scope')==='same'){ applyScope(); }
    });
  });
  // sessions
  async function refreshSessions(){
    var res=await send({type:'LIST_SESSIONS'});
    if(!res||!res.sessions) return;
    var sel=els.sessionSelect; var cur=sel.value;
    sel.innerHTML='<option value="">— saved sessions —</option>';
    res.sessions.forEach(function(s){ var o=document.createElement('option'); o.value=s.name; o.textContent=s.name+' ('+(s.engine&&s.engine.calls?s.engine.calls.length:0)+')'; sel.appendChild(o); });
    if(cur) sel.value=cur;
  }
  els.btnSaveSession.addEventListener('click',async()=>{
    var name=(els.sessionName.value.trim()||('Session '+(new Date().toLocaleTimeString())));
    var res=await send({type:'SAVE_SESSION', name:name}); if(res&&res.success){ toast('Saved "'+name+'"','success'); refreshSessions(); } else toast('Save failed','error');
  });
  els.btnLoadSession.addEventListener('click',async()=>{
    var name=els.sessionSelect.value; if(!name) { toast('Pick a session','info'); return; }
    var res=await send({type:'LOAD_SESSION', name:name}); if(res&&res.success){ toast('Loaded "'+name+'"','success'); fetchSession(); } else toast('Load failed','error');
  });
  els.btnDeleteSession.addEventListener('click',async()=>{
    var name=els.sessionSelect.value; if(!name) return;
    var res=await send({type:'DELETE_SESSION', name:name}); if(res&&res.success){ toast('Deleted','success'); refreshSessions(); }
  });
  els.btnRenameSession.addEventListener('click',async()=>{
    var oldName=els.sessionSelect.value; if(!oldName) return;
    var newName=prompt('Rename "'+oldName+'" to:', oldName); if(!newName||newName===oldName) return;
    var res=await send({type:'RENAME_SESSION', oldName:oldName, newName:newName}); if(res&&res.success){ toast('Renamed','success'); refreshSessions(); }
  });
  els.btnShowMore.addEventListener('click',()=>{ visibleLimit+=100; renderFlow(); lastFlowSig=null; });

  // export dialog
  function openExport(){
    var n=(session.calls||[]).filter(c=>c.checked!==false).length;
    els.exportCount.textContent=n+' selected';
    els.expName.value='';
    els.expBaseUrl.value='';
    els.expRedact.checked=!!(session.prefs&&session.prefs.redactAuth);
    els.expKeepOrigin.checked=!!(session.prefs&&session.prefs.keepOrigin);
    els.expExamples.checked=true;
    // auth warn
    var authChecked=0; // we estimate via stats? Full check requires GET_CALL per call; do quick async count
    (async function(){
      var count=0;
      for(var i=0;i<(session.calls||[]).length;i++){
        if(session.calls[i].checked===false) continue;
        var r=await send({type:'GET_CALL', id:session.calls[i].id});
        if(r&&r.call && (r.call.requestHeaders||[]).some(function(h){return h&&h.name&&h.name.toLowerCase()==='authorization';})) count++;
        if(count>=3) break;
      }
      els.authWarn.classList.toggle('hidden', count<3);
    })();
    els.exportDlg.showModal();
  }
  els.btnExport.addEventListener('click',openExport);
  async function doExport(kind){
    var opts={ collectionName: els.expName.value.trim()||undefined, baseUrlOverride: els.expBaseUrl.value.trim()||undefined, redact: els.expRedact.checked, keepOrigin: els.expKeepOrigin.checked, includeExamples: els.expExamples.checked };
    // persist prefs
    send({type:'SET_PREFS', prefs:{ redactAuth: opts.redact, keepOrigin: opts.keepOrigin }});
    var msg={ type:'EXPORT_POSTMAN', opts: opts };
    if(kind==='copy') msg.clipboard=true;
    else if(kind==='env') msg.env=true;
    else if(kind==='har') msg.har=true;
    else if(kind==='openapi') msg.openapi=true;
    var res=await send(msg);
    if(res && res.success){
      if(kind==='copy' && res.clipboard){
        var ok=await copyToClipboard(res.clipboard);
        toast(ok?'Collection copied':'Could not copy','success');
      } else if(res.success){
        var names={ env:'Env downloaded', har:'HAR downloaded', openapi:'OpenAPI downloaded' };
        toast(names[kind]||'Downloaded','success');
      }
      els.exportDlg.close();
    } else {
      var err=(res&&res.error)||'Export failed';
      var hint='';
      if(err.toLowerCase().indexOf('download')!==-1) hint=' — check downloads permission';
      toast(err+hint,'error');
    }
  }
  els.btnExportDownload.addEventListener('click',()=>doExport('download'));
  els.btnExportCopy.addEventListener('click',()=>doExport('copy'));
  els.btnExportEnv.addEventListener('click',()=>doExport('env'));
  els.btnExportHar.addEventListener('click',()=>doExport('har'));
  els.btnExportOpenApi.addEventListener('click',()=>doExport('openapi'));

  els.btnHelp.addEventListener('click',()=>els.helpDlg.showModal());

  /* ---------- keyboard ---------- */
  document.addEventListener('keydown',function(e){
    if(e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA' || e.target.tagName==='SELECT'){
      if(e.key==='Escape'){ e.target.blur(); }
      return;
    }
    if(e.key==='/' ){ e.preventDefault(); els.filter.focus(); }
    else if(e.key==='r' || e.key==='R'){ e.preventDefault(); if(session.isRecording) els.btnStop.click(); else els.btnStart.click(); }
    else if(e.key==='p' || e.key==='P'){ e.preventDefault(); if(session.isRecording) els.btnPause.click(); }
    else if(e.key==='e' || e.key==='E'){ e.preventDefault(); if(!els.btnExport.disabled) openExport(); }
    else if(e.key==='x' || e.key==='X'){ e.preventDefault(); els.btnExpand.click(); }
    else if(e.key==='c' || e.key==='C'){ e.preventDefault(); els.btnClear.click(); }
    else if(e.key==='f' || e.key==='F'){ e.preventDefault(); els.btnFiltered.click(); }
    else if(e.key==='?' ){ e.preventDefault(); els.helpDlg.showModal(); }
    else if(e.key==='Escape'){ if(els.exportDlg.open) els.exportDlg.close(); if(els.helpDlg.open) els.helpDlg.close(); }
  });

  // init chips UI
  els.chipRow.querySelectorAll('[data-chip]').forEach(function(el){ el.classList.toggle('active', el.getAttribute('data-chip')==='all'); });
  // init scope input from session
  // keyboard hint: close dialogs on backdrop click
  els.exportDlg.addEventListener('click',function(e){ if(e.target===els.exportDlg) els.exportDlg.close(); });
  els.helpDlg.addEventListener('click',function(e){ if(e.target===els.helpDlg) els.helpDlg.close(); });

  chrome.runtime.onMessage.addListener((message)=>{ if(message&&message.type==='SESSION_UPDATED') scheduleFetch(); });
  fetchSession();
  // refresh elapsed every second even when no SESSION_UPDATED
  setInterval(updateElapsed,1000);
})();
