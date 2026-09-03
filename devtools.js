/**
 * ApiTap — DevTools script
 * Primary network capture path. Converts every finished DevTools network request
 * into an internal apiCall with method, url, status, request/response headers,
 * request body and response body, and forwards it to the background worker.
 *
 * Requirement: network capture only runs while DevTools is open on the tab —
 * the same constraint the base FlowTrace extension has.
 */
(function () {
  'use strict';

  const MAX_BODY_CHARS = 200000; // keep in sync with utils/correlation.js
  const TAB_ID = chrome.devtools.inspectedWindow.tabId;

  chrome.devtools.panels.create('ApiTap', '', 'panel.html', (panel) => {
    console.debug('[ApiTap] DevTools panel created');
  });

  chrome.devtools.network.onRequestFinished.addListener((request) => {
    try {
      const rawStatus = request.response ? request.response.status : null;
      const normalizedStatus = rawStatus === 304 ? 200 : rawStatus;

      let requestBody = null;
      if (request.request.postData) {
        const text = request.request.postData.text;
        requestBody = text != null ? String(text) : null;
      }

      // Timestamp request START (not finish) so step correlation measures
      // click-to-request, not click-to-response (slow endpoints stay linked).
      const startedAt = Date.parse(request.startedDateTime || '');

      const apiCall = {
        tabId: TAB_ID,
        method: request.request.method || 'GET',
        url: request.request.url || '',
        status: normalizedStatus,
        rawStatus: rawStatus,
        requestHeaders: request.request.headers || [],
        responseHeaders: request.response ? (request.response.headers || []) : [],
        requestBody: requestBody,
        responseBody: null,
        ts: Number.isNaN(startedAt) ? Date.now() : startedAt,
        capture: { source: 'devtools', mode: 'devtools-primary' }
      };

      request.getContent((body, encoding) => {
        if (body && body.length > MAX_BODY_CHARS) {
          apiCall.responseBody = body.slice(0, MAX_BODY_CHARS) +
            '\n// [ApiTap] truncated (' + body.length + ' chars total)';
        } else {
          apiCall.responseBody = body || null;
        }
        try {
          // Async failures land in the callback: consume runtime.lastError so
          // a terminating SW (MV3) never logs an uncatched port error.
          chrome.runtime.sendMessage({ type: 'API_CALL', apiCall: apiCall }, () => void chrome.runtime.lastError);
        } catch (e) {
          console.debug('[ApiTap] Failed to send API_CALL to background:', e.message);
        }
      });
    } catch (err) {
      console.debug('[ApiTap] Error processing network request:', err.message);
    }
  });
})();