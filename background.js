/**
 * ApiTap — Background service worker
 * Central hub: message router, recording state (debugger-attached tab), session
 * persistence, endpoint grouping, and Postman export dispatch.
 * The service worker may be terminated at any moment (MV3), so every handler
 * awaits ensureSessionLoaded() before touching state.
 */
'use strict';

importScripts('utils/filter.js', 'utils/correlation.js', 'utils/postman.js', 'utils/har.js', 'utils/debugcapture.js');

const SESSION_STORAGE_KEY = 'apitapSession';
const SESSIONS_KEY = 'apitapSessions';
const PREFS_KEY = 'apitapPrefs';
const ONBOARDING_KEY = 'apitapOnboarding';
const PERSIST_DEBOUNCE_MS = 500;
const MAX_SESSIONS = 5;

let isRecording = false;
let isPaused = false;
let recordingStartTime = null;
let recordingTabId = null;
let recordingTabTitle = null;
let lastStopReason = null;
let lastStopTime = null;
let pendingRequests = new Map();
let correlator = null;
let restoreStatePromise = restorePersistedSession();
let persistTimer = null;
let prefs = { keepOrigin: false, redactAuth: false, onboardingDismissed: false };
let scopeAllowlist = null; // null = all, else array of host substrings lowercased

function initCorrelator() {
  if (!correlator) correlator = new ApiTapCorrelator();
  return correlator;
}

function broadcastUpdate() {
  try {
    chrome.runtime.sendMessage({ type: 'SESSION_UPDATED' }, () => void chrome.runtime.lastError);
  } catch (e) { }
}

/* ---------- persistence ---------- */

async function persistSession() {
  try {
    await chrome.storage.local.set({
      [SESSION_STORAGE_KEY]: {
        isRecording: isRecording,
        isPaused: isPaused,
        recordingStartTime: recordingStartTime,
        recordingTabId: recordingTabId,
        recordingTabTitle: recordingTabTitle,
        lastStopReason: lastStopReason,
        lastStopTime: lastStopTime,
        scopeAllowlist: scopeAllowlist,
        engine: correlator ? correlator.serialize() : null
      },
      [PREFS_KEY]: prefs
    });
    return true;
  } catch (e) {
    console.debug('[ApiTap] persist failed:', e.message);
    return false;
  }
}

function schedulePersist() {
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistSession(); }, PERSIST_DEBOUNCE_MS);
}
function cancelPersist() { if (persistTimer != null) { clearTimeout(persistTimer); persistTimer = null; } }

async function restorePersistedSession() {
  try {
    const data = await chrome.storage.local.get([SESSION_STORAGE_KEY, PREFS_KEY]);
    const saved = data[SESSION_STORAGE_KEY];
    if (data[PREFS_KEY]) prefs = Object.assign(prefs, data[PREFS_KEY]);
    if (saved) {
      isRecording = !!saved.isRecording;
      isPaused = !!saved.isPaused;
      recordingStartTime = saved.recordingStartTime ?? null;
      recordingTabId = saved.recordingTabId ?? null;
      recordingTabTitle = saved.recordingTabTitle || null;
      lastStopReason = saved.lastStopReason || null;
      lastStopTime = saved.lastStopTime || null;
      scopeAllowlist = saved.scopeAllowlist || null;
      if (saved.engine) { const c = initCorrelator(); c.mergeState(saved.engine); }
      if (isRecording && recordingTabId != null) {
        try { await attachDebugger(recordingTabId); } catch (e) {
          stopCapture('detach-failed');
          recordingStartTime = null;
          await persistSession();
        }
      } else if (isRecording) {
        stopCapture('no-tab');
        recordingStartTime = null;
        await persistSession();
      }
    }
  } catch (e) { console.debug('[ApiTap] restore failed:', e.message); }
}

async function ensureSessionLoaded() { await restoreStatePromise; }

/* ---------- scope ---------- */
function isScopeAllowed(url) {
  if (!scopeAllowlist || !scopeAllowlist.length) return true;
  try {
    var host = new URL(url).hostname.toLowerCase();
    // quick chips: "api-only" handled in popup but allowlist is explicit hosts
    return scopeAllowlist.some(function (h) { return host === h || host.endsWith('.' + h); });
  } catch (e) { return true; }
}

/* ---------- downloading ---------- */
function downloadJson(filename, obj) {
  const payload = JSON.stringify(obj, null, 2);
  let bin = '';
  for (const b of new TextEncoder().encode(payload)) bin += String.fromCharCode(b);
  const url = 'data:application/json;base64,' + btoa(bin);
  return chrome.downloads.download({ url: url, filename: filename, saveAs: true }).then(() => ({ success: true })).catch((e) => ({ success: false, error: e.message }));
}
function clipboardPayload(obj) {
  return JSON.stringify(obj, null, 2);
}

/* ---------- sessions ---------- */
async function listSessions() {
  try { var d = await chrome.storage.local.get(SESSIONS_KEY); return d[SESSIONS_KEY] || []; } catch (e) { return []; }
}
async function saveNamedSession(name) {
  var c = correlator || initCorrelator();
  var sessions = await listSessions();
  var now = Date.now();
  var entry = { name: name || ('Session ' + new Date().toLocaleString()), ts: now, engine: c.serialize(), scopeAllowlist: scopeAllowlist };
  // upsert by name
  var idx = sessions.findIndex(function (s) { return s.name === entry.name; });
  if (idx !== -1) sessions.splice(idx, 1);
  sessions.unshift(entry);
  if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(0, MAX_SESSIONS);
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
  return sessions;
}
async function loadNamedSession(name) {
  var sessions = await listSessions();
  var found = sessions.find(function (s) { return s.name === name; });
  if (!found) return null;
  var c = new ApiTapCorrelator();
  c.mergeState(found.engine);
  correlator = c;
  scopeAllowlist = found.scopeAllowlist || null;
  await persistSession();
  broadcastUpdate();
  return found;
}
async function deleteNamedSession(name) {
  var sessions = await listSessions();
  var next = sessions.filter(function (s) { return s.name !== name; });
  await chrome.storage.local.set({ [SESSIONS_KEY]: next });
  return next;
}
async function renameNamedSession(oldName, newName) {
  var sessions = await listSessions();
  var f = sessions.find(function (s) { return s.name === oldName; });
  if (f) f.name = newName;
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
  return sessions;
}

/* ---------- debugger capture ---------- */
async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId: tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId: tabId }, 'Network.enable', {});
}
function clearCaptureState() { recordingTabId = null; recordingTabTitle = null; pendingRequests = new Map(); }
function stopCapture(reason) {
  isRecording = false;
  isPaused = false;
  if (reason) { lastStopReason = reason; lastStopTime = Date.now(); }
  clearCaptureState();
}
function ingestApiCall(call) {
  if (isPaused) return;
  if (!isScopeAllowed(call.url)) return;
  const c = correlator || initCorrelator();
  try { c.addCall(call); } catch (e) { console.debug('[ApiTap] ingest failed:', e.message); return; }
  schedulePersist();
  broadcastUpdate();
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === recordingTabId) {
    stopCapture(source.reason || 'debugger-detached');
    // reason mapping
    if (source.reason === 'replaced_with_devtools') lastStopReason = 'devtools';
    else if (!lastStopReason) lastStopReason = 'detached';
    persistSession();
    broadcastUpdate();
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!isRecording || isPaused || !params || source.tabId !== recordingTabId) return;
  switch (method) {
    case 'Network.requestWillBeSent': {
      const prior = pendingRequests.get(params.requestId);
      const rec = DebugCapture.requestStart(params);
      if (rec) {
        if (prior && prior.postData && !rec.postData && prior.method === rec.method) rec.postData = prior.postData;
        pendingRequests.set(params.requestId, rec);
      }
      break;
    }
    case 'Network.responseReceived': {
      const rec = pendingRequests.get(params.requestId);
      if (rec) DebugCapture.responseReceived(rec, params);
      break;
    }
    case 'Network.loadingFinished': {
      const rec = pendingRequests.get(params.requestId);
      if (!rec) break;
      chrome.debugger.sendCommand({ tabId: recordingTabId }, 'Network.getResponseBody', { requestId: params.requestId })
        .then((res) => {
          if (!pendingRequests.has(params.requestId)) return;
          pendingRequests.delete(params.requestId);
          ingestApiCall(DebugCapture.finish(rec, res && res.body, res && res.base64Encoded));
        })
        .catch(() => {
          if (!pendingRequests.has(params.requestId)) return;
          pendingRequests.delete(params.requestId);
          ingestApiCall(DebugCapture.finish(rec, null, false));
        });
      break;
    }
    case 'Network.loadingFailed': {
      const rec = pendingRequests.get(params.requestId);
      if (!rec) break;
      pendingRequests.delete(params.requestId);
      if (params.errorText) rec.errorText = params.errorText;
      ingestApiCall(DebugCapture.finish(rec, null, false));
      break;
    }
  }
});

/* ---------- handlers ---------- */
async function handleStartRecording(message, sendResponse) {
  await ensureSessionLoaded();
  if (isRecording) { sendResponse({ success: true, startedAt: recordingStartTime, tabId: recordingTabId }); return; }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || tab.id == null) { sendResponse({ success: false, error: 'No active tab to record' }); return; }
  recordingStartTime = Date.now();
  recordingTabId = tab.id;
  recordingTabTitle = tab.title || tab.url || '';
  pendingRequests = new Map();
  isRecording = true; isPaused = false;
  lastStopReason = null; lastStopTime = null;
  try { await attachDebugger(tab.id); } catch (e) {
    stopCapture(null); recordingStartTime = null;
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch (e2) {}
    sendResponse({ success: false, error: 'Could not record this tab: ' + e.message }); return;
  }
  initCorrelator();
  await persistSession();
  sendResponse({ success: true, startedAt: recordingStartTime, tabId: tab.id });
  broadcastUpdate();
}
async function handleStopRecording(message, sendResponse) {
  await ensureSessionLoaded();
  const tabId = recordingTabId;
  stopCapture('user-stop');
  try { if (tabId != null) await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
  cancelPersist(); await persistSession();
  sendResponse({ success: true, stoppedAt: Date.now() });
  broadcastUpdate();
}
async function handlePauseToggle(message, sendResponse) {
  await ensureSessionLoaded();
  if (!isRecording) { sendResponse({ success: false, error: 'Not recording' }); return; }
  isPaused = !isPaused;
  await persistSession();
  sendResponse({ success: true, paused: isPaused });
  broadcastUpdate();
}
async function handleClearSession(message, sendResponse) {
  await ensureSessionLoaded();
  const tabId = recordingTabId;
  stopCapture('clear');
  try { if (tabId != null) await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
  cancelPersist();
  correlator = null;
  recordingStartTime = null;
  // keep lastStopReason as 'clear' for UI
  lastStopReason = 'clear'; lastStopTime = Date.now();
  await persistSession();
  sendResponse({ success: true });
  broadcastUpdate();
}
async function handleRestoreSession(message, sendResponse) {
  await ensureSessionLoaded();
  if (!message.state) { sendResponse({ success: false, error: 'no state' }); return; }
  var c = new ApiTapCorrelator();
  // message.state is { calls, filtered, deduped } from serialize
  c.mergeState(message.state);
  correlator = c;
  await persistSession();
  sendResponse({ success: true });
  broadcastUpdate();
}
async function handleUpdateChecked(message, sendResponse) {
  await ensureSessionLoaded();
  const c = initCorrelator();
  const updated = c.setChecked(message.id, message.checked);
  if (!updated) { sendResponse({ success: false, error: 'no call or group matched' }); return; }
  await persistSession();
  sendResponse({ success: true, updated: updated });
  broadcastUpdate();
}
async function handleBulkChecked(message, sendResponse) {
  await ensureSessionLoaded();
  const c = initCorrelator();
  var ids = message.ids || [];
  var checked = !!message.checked;
  var mode = message.mode || 'ids'; // ids | all | none | invert | failed | 2xx | method:GET etc
  var updated = 0;
  if (mode === 'all') { for (var i=0;i<c.calls.length;i++) { c.calls[i].checked = true; updated++; } }
  else if (mode === 'none') { for (var i=0;i<c.calls.length;i++) { c.calls[i].checked = false; updated++; } }
  else if (mode === 'invert') { for (var i=0;i<c.calls.length;i++) { c.calls[i].checked = !c.calls[i].checked; updated++; } }
  else if (mode === 'failed') { for (var i=0;i<c.calls.length;i++) { var s=c.calls[i].status; var fail = s!=null && s>=400; c.calls[i].checked = !!checked ? fail : !fail ? c.calls[i].checked : false; if (fail===checked) updated++; } if (checked) { updated = 0; for (var k=0;k<c.calls.length;k++) if (c.calls[k].status!=null && c.calls[k].status>=400) { c.calls[k].checked=true; updated++; } } else { /* uncheck failed only */ updated=0; for (var k2=0;k2<c.calls.length;k2++) if (c.calls[k2].status!=null && c.calls[k2].status>=400) { c.calls[k2].checked=false; updated++; } }
  }
  else if (mode === '2xx') { updated = 0; for (var a=0;a<c.calls.length;a++) { var st=c.calls[a].status; if (st!=null && st>=200 && st<300) { c.calls[a].checked=checked; updated++; } } }
  else if (mode && mode.indexOf('method:')===0) { var m=mode.split(':')[1].toUpperCase(); updated=0; for (var b=0;b<c.calls.length;b++) if ((c.calls[b].method||'GET').toUpperCase()===m) { c.calls[b].checked=checked; updated++; } }
  else { for (var c2=0;c2<ids.length;c2++) updated += c.setChecked(ids[c2], checked); }
  await persistSession();
  sendResponse({ success: true, updated: updated });
  broadcastUpdate();
}

function sessionSnapshot() {
  const c = correlator || initCorrelator();
  return {
    isRecording: isRecording,
    isPaused: isPaused,
    recordingStartTime: recordingStartTime,
    recordingTabId: recordingTabId,
    recordingTabTitle: recordingTabTitle,
    lastStopReason: lastStopReason,
    lastStopTime: lastStopTime,
    scopeAllowlist: scopeAllowlist,
    prefs: prefs,
    calls: c.calls.map((call) => ({
      id: call.id,
      method: call.method,
      url: call.url,
      status: call.status,
      checked: call.checked,
      noiseReason: call.noiseReason,
      errorText: call.errorText || null,
      groupKey: c.groupKey(call),
      hasBody: !!(call.requestBody || call.responseBody)
    })),
    stats: c.getStats()
  };
}

async function handleExport(message, sendResponse) {
  await ensureSessionLoaded();
  const c = correlator || initCorrelator();
  const opts = message.opts || {};
  // merge prefs with opts
  var effOpts = { keepOrigin: !!(opts.keepOrigin || prefs.keepOrigin), redactAuth: !!(opts.redactAuth || prefs.redactAuth || opts.redact), collectionName: opts.collectionName, baseUrlOverride: opts.baseUrlOverride, includeExamples: opts.includeExamples !== false };
  const collection = PostmanExporter.buildCollection(c, effOpts);
  if (opts.collectionName && !collection.info.name) collection.info.name = opts.collectionName;
  // clipboard export
  if (message.clipboard) {
    sendResponse({ success: true, clipboard: clipboardPayload(collection) });
    return;
  }
  if (message.env) {
    var env = PostmanExporter.buildEnvironment(c, effOpts);
    var res2 = await downloadJson(PostmanExporter.suggestEnvFilename(collection), env);
    sendResponse(res2); return;
  }
  if (message.har) {
    var har = HarBuilder.buildHar(c);
    var res3 = await downloadJson((PostmanExporter.suggestFilename(collection).replace('.json','') + '.har'), har);
    sendResponse(res3); return;
  }
  if (message.openapi) {
    var oas = HarBuilder.buildOpenApi(c);
    var res4 = await downloadJson((PostmanExporter.suggestFilename(collection).replace('.json','') + '.openapi.json'), oas);
    sendResponse(res4); return;
  }
  const filename = opts.filename || PostmanExporter.suggestFilename(collection);
  const res = await downloadJson(filename, collection);
  sendResponse(res);
}

/* ---------- router ---------- */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING': handleStartRecording(message, sendResponse); return true;
    case 'STOP_RECORDING': handleStopRecording(message, sendResponse); return true;
    case 'PAUSE_TOGGLE': handlePauseToggle(message, sendResponse); return true;
    case 'CLEAR_SESSION': handleClearSession(message, sendResponse); return true;
    case 'RESTORE_SESSION': handleRestoreSession(message, sendResponse); return true;
    case 'GET_SESSION':
      ensureSessionLoaded().then(() => sendResponse({ success: true, session: sessionSnapshot() }));
      return true;
    case 'UPDATE_CHECKED': handleUpdateChecked(message, sendResponse); return true;
    case 'BULK_CHECKED': handleBulkChecked(message, sendResponse); return true;
    case 'SET_SCOPE':
      ensureSessionLoaded().then(async () => { scopeAllowlist = message.allowlist || null; await persistSession(); sendResponse({ success: true }); broadcastUpdate(); });
      return true;
    case 'SET_PREFS':
      ensureSessionLoaded().then(async () => { Object.assign(prefs, message.prefs || {}); await persistSession(); sendResponse({ success: true, prefs: prefs }); });
      return true;
    case 'GET_CALL':
      ensureSessionLoaded().then(() => {
        const c = correlator || initCorrelator();
        const call = c.calls.find((x) => x.id === message.id);
        sendResponse(call ? { success: true, call: call } : { success: false, error: 'no such call' });
      });
      return true;
    case 'EXPORT_POSTMAN': handleExport(message, sendResponse); return true;
    case 'SAVE_SESSION':
      ensureSessionLoaded().then(async () => { var s = await saveNamedSession(message.name); sendResponse({ success: true, sessions: s }); });
      return true;
    case 'LOAD_SESSION':
      ensureSessionLoaded().then(async () => { var f = await loadNamedSession(message.name); sendResponse(f ? { success: true } : { success: false, error: 'not found' }); });
      return true;
    case 'LIST_SESSIONS':
      listSessions().then((s) => sendResponse({ success: true, sessions: s }));
      return true;
    case 'DELETE_SESSION':
      deleteNamedSession(message.name).then((s) => sendResponse({ success: true, sessions: s }));
      return true;
    case 'RENAME_SESSION':
      renameNamedSession(message.oldName, message.newName).then((s) => sendResponse({ success: true, sessions: s }));
      return true;
    default:
      sendResponse({ success: false, error: 'Unknown message type: ' + message.type });
  }
  return false;
});
