/**
 * ApiTap — Background service worker
 * Central hub: message router, recording state, session persistence,
 * endpoint grouping, and Postman export dispatch.
 * The service worker may be terminated at any moment (MV3), so every handler
 * awaits ensureSessionLoaded() before touching state.
 */
'use strict';

importScripts('utils/filter.js', 'utils/correlation.js', 'utils/postman.js');

const SESSION_STORAGE_KEY = 'apitapSession';

let isRecording = false;
let recordingStartTime = null;
let correlator = null;
let restoreStatePromise = restorePersistedSession();

function initCorrelator() {
  if (!correlator) correlator = new ApiTapCorrelator();
  return correlator;
}

function broadcastUpdate() {
  try {
    // Consume runtime.lastError: no panel open (or panel closing) is expected here.
    chrome.runtime.sendMessage({ type: 'SESSION_UPDATED' }, () => void chrome.runtime.lastError);
  } catch (e) { /* no listeners */ }
}

/* ---------- persistence ---------- */

async function persistSession() {
  try {
    await chrome.storage.local.set({
      [SESSION_STORAGE_KEY]: {
        isRecording: isRecording,
        recordingStartTime: recordingStartTime,
        engine: correlator ? correlator.serialize() : null
      }
    });
    return true;
  } catch (e) {
    // Session stays in memory; recording must not wedge on a storage failure.
    console.debug('[ApiTap] persist failed:', e.message);
    return false;
  }
}

async function restorePersistedSession() {
  try {
    const data = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const saved = data[SESSION_STORAGE_KEY];
    if (saved) {
      isRecording = !!saved.isRecording;
      recordingStartTime = saved.recordingStartTime || null;
      if (saved.engine) {
        const c = initCorrelator();
        c.mergeState(saved.engine);
      }
    }
  } catch (e) {
    console.debug('[ApiTap] restore failed:', e.message);
  }
}

async function ensureSessionLoaded() {
  await restoreStatePromise;
}

/* ---------- downloading ---------- */

function downloadJson(filename, obj) {
  // MV3 service workers have NO URL.createObjectURL (document-context API), so
  // export via a base64 data URL. Unicode-safe: the JSON may hold non-Latin1
  // chars (em-dashes in names/descriptions), so byte-encode before btoa.
  const payload = JSON.stringify(obj, null, 2);
  let bin = '';
  for (const b of new TextEncoder().encode(payload)) bin += String.fromCharCode(b);
  const url = 'data:application/json;base64,' + btoa(bin);
  return chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: true
  }).then(() => ({ success: true })).catch((e) => ({ success: false, error: e.message }));
}

/* ---------- handlers ---------- */

async function handleStartRecording(message, sendResponse) {
  await ensureSessionLoaded();
  initCorrelator();
  isRecording = true;
  recordingStartTime = Date.now();
  await persistSession();

  sendResponse({ success: true, startedAt: recordingStartTime });
  broadcastUpdate();
}

async function handleStopRecording(message, sendResponse) {
  await ensureSessionLoaded();
  isRecording = false;
  await persistSession();
  sendResponse({ success: true, stoppedAt: Date.now() });
  broadcastUpdate();
}

async function handleClearSession(message, sendResponse) {
  await ensureSessionLoaded();
  isRecording = false;
  recordingStartTime = null;
  correlator = null;
  await persistSession();
  sendResponse({ success: true });
  broadcastUpdate();
}

async function handleApiCall(message, sender, sendResponse) {
  await ensureSessionLoaded();
  if (!isRecording) { sendResponse && sendResponse({ success: false, reason: 'not-recording' }); return; }
  const c = initCorrelator();
  const call = message.apiCall || {};
  c.addCall(call);
  await persistSession();
  broadcastUpdate();
  sendResponse && sendResponse({ success: true });
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

function sessionSnapshot() {
  const c = correlator || initCorrelator();
  return {
    isRecording: isRecording,
    recordingStartTime: recordingStartTime,
    calls: c.calls.map((call) => Object.assign({}, call, { groupKey: c.groupKey(call) })),
    stats: c.getStats()
  };
}

async function handleExport(message, sendResponse) {
  await ensureSessionLoaded();
  const c = correlator || initCorrelator();
  const res = await downloadJson('apitap-collection.json', PostmanExporter.buildCollection(c));
  sendResponse(res);
}

/* ---------- router ---------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING': handleStartRecording(message, sendResponse); return true;
    case 'STOP_RECORDING': handleStopRecording(message, sendResponse); return true;
    case 'CLEAR_SESSION': handleClearSession(message, sendResponse); return true;
    case 'GET_SESSION':
      ensureSessionLoaded().then(() => sendResponse({ success: true, session: sessionSnapshot() }));
      return true;
    case 'API_CALL': handleApiCall(message, sender, sendResponse); return true;
    case 'UPDATE_CHECKED': handleUpdateChecked(message, sendResponse); return true;
    case 'EXPORT_POSTMAN': handleExport(message, sendResponse); return true;
    default:
      sendResponse({ success: false, error: 'Unknown message type: ' + message.type });
  }
  return false;
});