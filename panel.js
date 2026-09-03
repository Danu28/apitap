/**
 * ApiTap — Panel controller
 * Reads the session from the background worker, renders endpoint groups with
 * export checkboxes, and triggers the Postman export of the checked calls.
 * Selection state lives in the persisted session (the panel dies when
 * DevTools closes); this view only sends UPDATE_CHECKED and re-renders.
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
    flowContainer: $('flowContainer'), toast: $('toast')
  };

  let session = { isRecording: false, calls: [], stats: {} };
  let fetchTimer = null;

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
      els.status.textContent = 'Recording';
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

  function groupLabel(key) {
    const p = String(key || '').split('|');
    return p.length === 3 ? (p[2] || p[1]) : key;
  }

  function callRow(call) {
    const row = document.createElement('div');
    row.className = 'call';
    row.innerHTML =
      '<input type="checkbox" data-check="' + call.id + '"' + (call.checked !== false ? ' checked' : '') + '>' +
      '<span class="method ' + methodClass(call.method) + '">' + escapeHtml(call.method) + '</span>' +
      '<span class="status ' + statusClass(call.status) + '">' + (call.status != null ? call.status : '—') + '</span>' +
      (call.noiseReason ? '<span class="pill pill-noise">' + escapeHtml(call.noiseReason) + '</span>' : '') +
      '<span class="call-url" title="' + escapeHtml(call.url) + '">' + escapeHtml(call.url) + '</span>';
    row.querySelector('[data-check]').addEventListener('change', (e) => {
      send({ type: 'UPDATE_CHECKED', id: call.id, checked: e.target.checked });
    });
    return row;
  }

  function renderFlow() {
    const host = els.flowContainer;
    host.innerHTML = '';
    const calls = session.calls || [];
    if (!calls.length) {
      host.className = 'empty';
      host.textContent = 'No recording yet. Start recording, then use the page.';
      return;
    }
    host.className = '';

    const groups = new Map();
    for (const call of calls) {
      const key = call.groupKey || 'unparseable';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }

    for (const [key, group] of groups) {
      const allChecked = group.every((c) => c.checked !== false);
      const someChecked = group.some((c) => c.checked !== false);
      const block = document.createElement('div');
      block.className = 'step';

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'step-head';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = allChecked;
      cb.indeterminate = someChecked && !allChecked;
      cb.addEventListener('click', (e) => e.stopPropagation()); // don't toggle expand
      cb.addEventListener('change', () => send({ type: 'UPDATE_CHECKED', id: key, checked: cb.checked }));
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
        (someChecked && !allChecked ? ' · ' + group.filter((c) => c.checked !== false).length + ' exported' : '');
      head.appendChild(cb);
      head.appendChild(badge);
      head.appendChild(label);
      head.appendChild(count);
      head.addEventListener('click', () => block.classList.toggle('open'));
      block.appendChild(head);

      for (const call of group) block.appendChild(callRow(call));
      host.appendChild(block);
    }
  }

  function renderFiltered() {
    const dropped = (session.calls || []).filter((c) => c.noiseReason).slice(-50).reverse();
    els.btnFiltered.disabled = !dropped.length;
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
    renderFlow();
    renderFiltered();
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
    $('filteredWrap').classList.toggle('hidden');
  });
  els.btnExport.addEventListener('click', async () => {
    const res = await send({ type: 'EXPORT_POSTMAN' });
    toast(res && res.success ? 'Collection downloaded' : 'Export failed');
  });

  /* ---------- live updates ---------- */

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'SESSION_UPDATED') scheduleFetch();
  });

  fetchSession();
})();