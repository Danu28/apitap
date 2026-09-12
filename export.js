(function(){
  const $=id=>document.getElementById(id);
  const els={count:$('count'), statCalls:$('statCalls'), statGroups:$('statGroups'), statFiltered:$('statFiltered'), statDeduped:$('statDeduped'),
    expName:$('expName'), expBaseUrl:$('expBaseUrl'), expRedact:$('expRedact'), expRedactQuery:$('expRedactQuery'), expKeepOrigin:$('expKeepOrigin'), expExamples:$('expExamples'), authWarn:$('authWarn'),
    btnDownload:$('btnDownload'), btnCopy:$('btnCopy'), btnEnv:$('btnEnv'), btnHar:$('btnHar'), btnOpenApi:$('btnOpenApi'), preview:$('preview'), toast:$('toast')};
  function send(m){ return new Promise(r=>{ try{ chrome.runtime.sendMessage(m, res=>{ const e=chrome.runtime.lastError; if(res===undefined) r({success:false,error:e?e.message:'no response'}); else r(res); }); }catch(e){ r({success:false,error:e.message}); } }); }
  function toast(msg, ok){ els.toast.textContent=msg; els.toast.className='show'; els.toast.style.borderColor=ok?'var(--green)':'var(--rose)'; setTimeout(()=>els.toast.className='',2500); }
  async function copy(t){ try{ await navigator.clipboard.writeText(t); return true;}catch(e){ const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); const ok=document.execCommand('copy'); ta.remove(); return ok; } }
  async function load(){
    const res=await send({type:'GET_SESSION'}); const s=res&&res.session; if(!s) return;
    const sel=(s.calls||[]).filter(c=>c.checked!==false).length;
    $('count').textContent= sel+' selected of '+(s.calls||[]).length;
    $('statCalls').textContent=s.stats.calls||0; $('statGroups').textContent=s.stats.groups||0; $('statFiltered').textContent=s.stats.filtered||0; $('statDeduped').textContent=s.stats.deduped||0;
    $('expRedact').checked=!!(s.prefs&&s.prefs.redactAuth);
    $('expRedactQuery').checked=!!(s.prefs&&s.prefs.redactQueryTokens);
    $('expKeepOrigin').checked=!!(s.prefs&&s.prefs.keepOrigin);
    // auth warn
    const ids=(s.calls||[]).filter(c=>c.checked!==false).map(c=>c.id).slice(0,20);
    const results=await Promise.all(ids.map(id=>send({type:'GET_CALL',id})));
    let cnt=0; results.forEach(r=>{ if(r&&r.call && (r.call.requestHeaders||[]).some(h=>h&&h.name&&h.name.toLowerCase()==='authorization')) cnt++;});
    $('authWarn').style.display=cnt>=3?'block':'none';
  }
  async function doExport(kind){
    const opts={ collectionName: $('expName').value.trim()||undefined, baseUrlOverride: $('expBaseUrl').value.trim()||undefined, redact: $('expRedact').checked, redactQueryTokens: $('expRedactQuery').checked, keepOrigin: $('expKeepOrigin').checked, includeExamples: $('expExamples').checked };
    await send({type:'SET_PREFS', prefs:{redactAuth:opts.redact, redactQueryTokens:opts.redactQueryTokens, keepOrigin:opts.keepOrigin}});
    const msg={type:'EXPORT_POSTMAN', opts}; if(kind==='copy') msg.clipboard=true; else if(kind==='env') msg.env=true; else if(kind==='har') msg.har=true; else if(kind==='openapi') msg.openapi=true;
    const res=await send(msg);
    if(res&&res.success){
      if(kind==='copy'&&res.clipboard){ const ok=await copy(res.clipboard); toast(ok?'Collection copied':'Copy failed',ok); $('preview').style.display='block'; $('preview').textContent=res.clipboard.slice(0,8000); }
      else { toast({env:'Env downloaded',har:'HAR downloaded',openapi:'OpenAPI downloaded'}[kind]||'Downloaded',true); }
    } else toast((res&&res.error)||'Export failed',false);
  }
  $('btnDownload').addEventListener('click',()=>doExport('download'));
  $('btnCopy').addEventListener('click',()=>doExport('copy'));
  $('btnEnv').addEventListener('click',()=>doExport('env'));
  $('btnHar').addEventListener('click',()=>doExport('har'));
  $('btnOpenApi').addEventListener('click',()=>doExport('openapi'));
  load();
})();
