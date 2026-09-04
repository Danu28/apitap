/**
 * ApiTap — Background service worker
 * Central hub: message router, recording state (debugger-attached tab), session
 * persistence, endpoint grouping, and Postman export dispatch.
 * The service worker may be terminated at any moment (MV3), so every handler
 * awaits ensureSessionLoaded() before touching state.
 */
'use strict';

importScripts('utils/filter.js', 'utils/correlation.js', 'utils/postman.js', 'utils/debugcapture.js');

const SESSION_STORAGE_KEY = 'apitapSession';

let isRecording = false;
let recordingStartTime = null;
let recordingTabId = null;
let pendingRequests = new Map(); // requestId -> in-flight capture record (never persisted)
let correlator = null;
let restoreStatePromise = restorePersistedSession();

function initCorrelator() {
  if (!correlator) correlator = new ApiTapCorrelator();
  return correlator;
}

function broadcastUpdate() {
  try {
    // Consume runtime.lastError: no popup open (or popup closing) is expected here.
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
        recordingTabId: recordingTabId,
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
      recordingStartTime = saved.recordingStartTime ?? null;
      recordingTabId = saved.recordingTabId ?? null; // ?? not ||: tabId 0 is valid
      if (saved.engine) {
        const c = initCorrelator();
        c.mergeState(saved.engine);
      }
      // An SW restart mid-recording kills the debugger session: re-attach to
      // the recorded tab. A stale tab (closed while the SW was down) or an
      // old-schema session without a saved tab means the recording is over —
      // correct the state instead of showing a dead "Recording".
      if (isRecording && recordingTabId != null) {
        try {
          await attachDebugger(recordingTabId);
        } catch (e) {
          stopCapture();
          recordingStartTime = null;
          await persistSession();
        }
      } else if (isRecording) {
        stopCapture();
        recordingStartTime = null;
        await persistSession();
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

/* ---------- debugger capture ---------- */

async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId: tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId: tabId }, 'Network.enable', {});
}

function clearCaptureState() {
  recordingTabId = null;
  pendingRequests = new Map();
}

// Single teardown for Stop, Clear, detach and restore-failure paths — flips
// recording off in one place so the state can't drift between handlers.
function stopCapture() {
  isRecording = false;
  clearCaptureState();
}

// Captured CDP events flowing into the engine, in sw context (no messaging hop).
function ingestApiCall(call) {
  const c = correlator || initCorrelator();
  try {
    c.addCall(call);
  } catch (e) {
    console.debug('[ApiTap] ingest failed:', e.message);
    return;
  }
  persistSession();
  broadcastUpdate();
}

chrome.debugger.onDetach.addListener((source) => {
  // The tab was detached under us (DevTools opened, another debugger took over,
  // or the tab closed): stop recording gracefully rather than leave a dead state.
  if (source.tabId === recordingTabId) {
    stopCapture();
    persistSession();
    broadcastUpdate();
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!isRecording || !params || source.tabId !== recordingTabId) return;
  switch (method) {
    case 'Network.requestWillBeSent': {
      const rec = DebugCapture.requestStart(params);
      if (rec) pendingRequests.set(params.requestId, rec);
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
          // Session guard: Stop/Clear swap in a fresh map while the body fetch
          // is in flight — a requestId still present means THIS session asked.
          if (!pendingRequests.has(params.requestId)) return;
          pendingRequests.delete(params.requestId);
          ingestApiCall(DebugCapture.finish(rec, res && res.body, res && res.base64Encoded));
        })
        .catch(() => {
          // No body for this request (media/streams) — still record the call.
          if (!pendingRequests.has(params.requestId)) return;
          pendingRequests.delete(params.requestId);
          ingestApiCall(DebugCapture.finish(rec, null, false));
        });
      break;
    }
  }
});

/* ---------- handlers ---------- */

async function handleStartRecording(message, sendResponse) {
  await ensureSessionLoaded();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || tab.id == null) {
    sendResponse({ success: false, error: 'No active tab to record' });
    return;
  }
  // State first so events flowing in right after Network.enable are captured
  // (no dead window); revert everything if the attach itself fails.
  recordingStartTime = Date.now();
  recordingTabId = tab.id;
  pendingRequests = new Map();
  isRecording = true;
  try {
    await attachDebugger(tab.id);
  } catch (e) {
    stopCapture();
    recordingStartTime = null;
    sendResponse({ success: false, error: 'Could not record this tab: ' + e.message });
    return;
  }
  initCorrelator();
  await persistSession();
  sendResponse({ success: true, startedAt: recordingStartTime, tabId: tab.id });
  broadcastUpdate();
}

async function handleStopRecording(message, sendResponse) {
  await ensureSessionLoaded();
  const tabId = recordingTabId; // detach still needs the id after stopCapture() nulls it
  stopCapture();
  try {
    if (tabId != null) await chrome.debugger.detach({ tabId: tabId });
  } catch (e) { /* already detached */ }
  await persistSession();
  sendResponse({ success: true, stoppedAt: Date.now() });
  broadcastUpdate();
}

async function handleClearSession(message, sendResponse) {
  await ensureSessionLoaded();
  const tabId = recordingTabId;
  stopCapture();
  try {
    if (tabId != null) await chrome.debugger.detach({ tabId: tabId });
  } catch (e) { /* already detached */ }
  correlator = null;
  recordingStartTime = null;
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

// Only the fields the popup renders are sent; request/response bodies and the
// full header lists stay in the worker (they'd inflate every SESSION_UPDATED
// re-fetch for no benefit to the view).
function sessionSnapshot() {
  const c = correlator || initCorrelator();
  return {
    isRecording: isRecording,
    recordingStartTime: recordingStartTime,
    recordingTabId: recordingTabId,
    calls: c.calls.map((call) => ({
      id: call.id,
      method: call.method,
      url: call.url,
      status: call.status,
      checked: call.checked,
      noiseReason: call.noiseReason,
      groupKey: c.groupKey(call)
    })),
    stats: c.getStats()
  };
}

async function handleExport(message, sendResponse) {
  await ensureSessionLoaded();
  const c = correlator || initCorrelator();
  const collection = PostmanExporter.buildCollection(c);
  const res = await downloadJson(PostmanExporter.suggestFilename(collection), collection);
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
    case 'UPDATE_CHECKED': handleUpdateChecked(message, sendResponse); return true;
    case 'EXPORT_POSTMAN': handleExport(message, sendResponse); return true;
    default:
      sendResponse({ success: false, error: 'Unknown message type: ' + message.type });
  }
  return false;
});