/**
 * ApiTap — Popup controller
 * Reads the session from the background worker, renders a Domain → Endpoint →
 * Request flow with tri-state export checkboxes at every level (a domain or
 * endpoint toggle fans out to its descendant requests), and triggers the
 * Postman export of the checked calls.
 * The popup closes when the user returns to the page; recording continues in
 * the service worker and this view re-syncs on every open via GET_SESSION.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const els = {
    status: $('status'), btnStart: $('btnStart'), btnStop: $('btnStop'),
    btnClear: $('btnClear'), btnExport: $('btnExport'),
    statCalls: $('statCalls'), statGroups: $('statGroups'),
    statFiltered: $('statFiltered'), statDeduped: $('statDeduped'),
    btnFiltered: $('btnFiltered'), filteredList: $('filteredList'),
    flowContainer: $('flowContainer'), toast: $('toast'),
    filter: $('filter'), btnExpand: $('btnExpand')
  };

  let session = { isRecording: false, calls: [], stats: {} };
  let fetchTimer = null;
  // Tree helpers live in utils/tree.js (ApiTapTree) so the tri-state grouping
  // can be unit-tested in Node. `expanded` persists open sections across the
  // 200ms live re-renders so the view never flickers back to collapsed.
  const { buildDomainTree, selectionState, groupLabel } = ApiTapTree;
  let expanded = new Set();   // 'd:'+host / 'e:'+groupKey — survives re-renders
  let filterQuery = '';
  let lastFlowSig = null;     // skip renderFlow when nothing relevant changed

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          // Reading lastError marks it handled; undefined res = port closed
          // (e.g. service worker terminated mid-handling) — surface it, don't fake success.
          const err = chrome.runtime.lastError;
          if (res === undefined) resolve({ success: false, error: err ? err.message : 'no response (port closed)' });
          else resolve(res);
        });
      } catch (e) { resolve({ success: false, error: e.message }); }
    });
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  async function fetchSession() {
    const res = await send({ type: 'GET_SESSION' });
    if (res && res.session) { session = res.session; render(); }
  }

  // SESSION_UPDATED fires per captured call; collapse the re-fetch to 200ms.
  function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchSession, 200);
  }

  /* ---------- rendering ---------- */

  function updateStatus() {
    if (session.isRecording) {
      els.status.dataset.state = 'recording';
      els.status.textContent = 'Recording · tab ' + (session.recordingTabId != null ? session.recordingTabId : '?');
      els.btnStart.disabled = true;
      els.btnStop.disabled = false;
    } else {
      els.status.dataset.state = 'idle';
      els.status.textContent = 'Idle';
      els.btnStart.disabled = false;
      els.btnStop.disabled = true;
    }
  }

  function updateStats() {
    els.statCalls.textContent = session.stats.calls || 0;
    els.statGroups.textContent = session.stats.groups || 0;
    els.statFiltered.textContent = session.stats.filtered || 0;
    els.statDeduped.textContent = session.stats.deduped || 0;
    const anyChecked = (session.calls || []).some((c) => c.checked !== false);
    els.btnExport.disabled = !anyChecked;
  }

  function methodClass(m) { return 'm-' + String(m || '').toLowerCase(); }
  function statusClass(s) { return s == null ? '' : (s >= 400 ? 'bad' : 'ok'); }

  function callRow(call) {
    const row = document.createElement('div');
    row.className = 'call';
    row.innerHTML =
      '<input type="checkbox" data-check="' + escapeHtml(call.id) + '"' + (call.checked !== false ? ' checked' : '') + '>' +
      '<span class="method ' + methodClass(call.method) + '">' + escapeHtml(call.method) + '</span>' +
      '<span class="status ' + statusClass(call.status) + '">' + (call.status != null ? call.status : '—') + '</span>' +
      (call.noiseReason ? '<span class="pill pill-noise">' + escapeHtml(call.noiseReason) + '</span>' : '') +
      (call.errorText ? '<span class="pill pill-fail" title="' + escapeHtml(call.errorText) + '">failed</span>' : '') +
      '<span class="call-url" title="' + escapeHtml(call.url) + '">' + escapeHtml(call.url) + '</span>';
    row.querySelector('[data-check]').addEventListener('change', (e) => {
      send({ type: 'UPDATE_CHECKED', id: call.id, checked: e.target.checked });
    });
    const curlBtn = document.createElement('button');
    curlBtn.type = 'button';
    curlBtn.className = 'row-action';
    curlBtn.title = 'Copy as cURL';
    curlBtn.textContent = 'curl';
    curlBtn.addEventListener('click', async () => {
      const res = await send({ type: 'GET_CALL', id: call.id });
      if (!res || !res.call) { toast('No request data to copy'); return; }
      toast((await copyToClipboard(buildCurl(res.call))) ? 'cURL copied' : 'Could not copy');
    });
    row.appendChild(curlBtn);
    return row;
  }

  /* ---------- domain -> endpoint -> request grouping ---------- */

  // buildDomainTree / selectionState / groupLabel come from utils/tree.js.

  function callsSig(calls) {
    let checked = 0;
    for (const c of calls) if (c.checked !== false) checked++;
    return calls.length + ':' + checked;
  }

  function filteredCalls(calls) {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return calls;
    return calls.filter((c) =>
      (c.url && c.url.toLowerCase().indexOf(q) !== -1) ||
      (c.method && c.method.toLowerCase().indexOf(q) !== -1));
  }

  // cURL renderer for the per-request copy action.
  function buildCurl(call) {
    const q = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
    const parts = ['curl'];
    const method = call.method || 'GET';
    if (method !== 'GET') parts.push('-X ' + method);
    parts.push(q(call.url));
    for (const h of call.requestHeaders || []) {
      if (!h || !h.name) continue;
      parts.push('-H ' + q(String(h.name) + ': ' + (h.value != null ? String(h.value) : '')));
    }
    if (call.requestBody) parts.push('--data-raw ' + q(call.requestBody));
    return parts.join(' ');
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      // Fallback for contexts without async clipboard write.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e2) { return false; }
    }
  }

  // Tri-state checkbox: click stops propagation (won't toggle section expand),
  // and the parent's onChange drives its descendants via UPDATE_CHECKED.
  function triCheckbox(state, onChange) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.all;
    cb.indeterminate = state.some && !state.all;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => onChange(cb.checked));
    return cb;
  }

  // Section header (domain or endpoint) that starts collapsed and exposes
  // aria-expanded while its click handler toggles the parent `.open`.
  function collapsibleHead(kind) {
    const head = document.createElement('button');
    head.type = 'button';
    head.className = kind + '-head';
    head.setAttribute('aria-expanded', 'false');
    return head;
  }

  function endpointBlock(key, group) {
    const state = selectionState(group);
    const ek = 'e:' + key;
    const block = document.createElement('div');
    block.className = 'step' + (expanded.has(ek) ? ' open' : '');

    const head = collapsibleHead('step');
    head.setAttribute('aria-expanded', String(expanded.has(ek)));
    head.appendChild(triCheckbox(state, (checked) => send({ type: 'UPDATE_CHECKED', id: key, checked: checked })));
    const first = group[0];
    const badge = document.createElement('span');
    badge.className = 'method ' + methodClass(first.method);
    badge.textContent = first.method;
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = groupLabel(key);
    const count = document.createElement('span');
    count.className = 'pill';
    count.textContent = group.length +
      (state.some && !state.all ? ' · ' + state.checked + ' selected' : '');
    head.appendChild(badge);
    head.appendChild(label);
    head.appendChild(count);
    head.addEventListener('click', () => {
      const open = block.classList.toggle('open');
      open ? expanded.add(ek) : expanded.delete(ek);
      head.setAttribute('aria-expanded', String(open));
    });
    block.appendChild(head);

    for (const call of group) block.appendChild(callRow(call));
    return block;
  }

  function domainBlock(domain) {
    const allCalls = [];
    for (const group of domain.endpoints.values()) for (const call of group) allCalls.push(call);
    const state = selectionState(allCalls);
    const dk = 'd:' + domain.host;
    const block = document.createElement('div');
    block.className = 'domain' + (expanded.has(dk) ? ' open' : '');

    const head = collapsibleHead('domain');
    head.setAttribute('aria-expanded', String(expanded.has(dk)));
    head.appendChild(triCheckbox(state, (checked) => {
      // A domain toggle fans out to one UPDATE_CHECKED per endpoint group; the
      // engine's setChecked(id, checked) handles whole groups by key.
      for (const key of domain.endpoints.keys()) send({ type: 'UPDATE_CHECKED', id: key, checked: checked });
    }));
    const name = document.createElement('span');
    name.className = 'domain-name';
    name.textContent = domain.host;
    const count = document.createElement('span');
    count.className = 'pill';
    const nE = domain.endpoints.size;
    const nC = allCalls.length;
    count.textContent = nE + ' endpoint' + (nE === 1 ? '' : 's') + ' · ' + nC + ' request' + (nC === 1 ? '' : 's') +
      (state.none ? '' : ' — ' + state.checked + ' selected');
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '\u25B8';
    head.appendChild(name);
    head.appendChild(count);
    head.appendChild(chevron);
    head.addEventListener('click', () => {
      const open = block.classList.toggle('open');
      open ? expanded.add(dk) : expanded.delete(dk);
      head.setAttribute('aria-expanded', String(open));
    });
    block.appendChild(head);

    const body = document.createElement('div');
    body.className = 'domain-body';
    for (const [key, group] of domain.endpoints) body.appendChild(endpointBlock(key, group));
    block.appendChild(body);
    return block;
  }

  function renderFlow() {
    const host = els.flowContainer;
    const allCalls = session.calls || [];
    host.innerHTML = '';
    if (!allCalls.length) {
      host.className = 'empty';
      host.textContent = 'No recording yet. Start recording, then use the page.';
      return;
    }
    const calls = filteredCalls(allCalls);
    if (!calls.length) {
      host.className = 'empty';
      host.textContent = 'No calls match \u0022' + filterQuery + '\u0022';
      return;
    }
    host.className = '';
    for (const domain of buildDomainTree(calls)) host.appendChild(domainBlock(domain));
  }

  function renderFiltered() {
    const dropped = (session.calls || []).filter((c) => c.noiseReason).slice(-50).reverse();
    els.btnFiltered.disabled = !dropped.length;
    // No dropped calls left to show (e.g. session cleared): collapse the panel
    // so a stale empty pane doesn't linger next to a disabled button.
    if (!dropped.length) {
      const wrap = $('filteredWrap');
      wrap.classList.add('hidden');
      els.btnFiltered.setAttribute('aria-expanded', 'false');
    }
    const host = els.filteredList;
    host.innerHTML = '';
    for (const d of dropped) {
      const row = document.createElement('div');
      row.className = 'filtered-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = d.checked !== false;
      cb.addEventListener('change', () => send({ type: 'UPDATE_CHECKED', id: d.id, checked: cb.checked }));
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = d.noiseReason;
      const u = document.createElement('span');
      u.className = 'call-url';
      u.title = d.url;
      u.textContent = d.url;
      row.appendChild(cb);
      row.appendChild(pill);
      row.appendChild(u);
      host.appendChild(row);
    }
  }

  function render() {
    updateStatus();
    updateStats();
    // Avoid tearing down/rebuilding the whole flow on live updates that didn't
    // actually add or re-check anything — the signatur covers count + checked.
    const sig = callsSig(session.calls || []);
    if (sig !== lastFlowSig) { lastFlowSig = sig; renderFlow(); renderFiltered(); }
  }

  /* ---------- actions ---------- */

  els.btnStart.addEventListener('click', async () => {
    const res = await send({ type: 'START_RECORDING' });
    if (res && res.success) toast('Recording started');
    else toast('Failed to start: ' + (res && res.error));
    fetchSession();
  });

  els.btnStop.addEventListener('click', async () => {
    const res = await send({ type: 'STOP_RECORDING' });
    if (res && res.success) toast('Recording stopped');
    fetchSession();
  });

  els.btnClear.addEventListener('click', async () => {
    await send({ type: 'CLEAR_SESSION' });
    toast('Session cleared');
    fetchSession();
  });

  els.btnFiltered.addEventListener('click', () => {
    const wrap = $('filteredWrap');
    const nowHidden = wrap.classList.toggle('hidden');
    els.btnFiltered.setAttribute('aria-expanded', String(!nowHidden));
  });
  els.btnExpand.addEventListener('click', () => {
    if (els.btnExpand.classList.contains('active')) {
      expanded = new Set();
      els.btnExpand.classList.remove('active');
      els.btnExpand.textContent = 'Expand all';
    } else {
      expanded = new Set();
      for (const domain of buildDomainTree(session.calls || [])) {
        expanded.add('d:' + domain.host);
        for (const key of domain.endpoints.keys()) expanded.add('e:' + key);
      }
      els.btnExpand.classList.add('active');
      els.btnExpand.textContent = 'Collapse all';
    }
    renderFlow();
  });
  els.filter.addEventListener('input', () => {
    filterQuery = els.filter.value;
    renderFlow();
  });
  els.btnExport.addEventListener('click', async () => {
    const res = await send({ type: 'EXPORT_POSTMAN' });
    if (res && res.success) {
      const n = (session.calls || []).filter((c) => c.checked !== false).length;
      toast('Downloaded ' + n + ' request' + (n === 1 ? '' : 's'));
    } else {
      toast('Export failed' + (res && res.error ? ': ' + res.error : ''));
    }
  });

  /* ---------- live updates ---------- */

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'SESSION_UPDATED') scheduleFetch();
  });

  fetchSession();
})();