/**
 * ApiTap — DebugCapture
 * Pure mapping of CDP Network events (chrome.debugger) to the internal apiCall
 * shape the engine ingests. No chrome APIs here — testable in Node.
 * Dual-exported for the service worker (globalThis) and Node tests (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.DebugCapture = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // CDP sends headers as flat { name: value } maps — normalize to arrays.
  function headersToArray(headersObj) {
    if (!headersObj || typeof headersObj !== 'object') return [];
    return Object.keys(headersObj).map((name) => ({ name: name, value: String(headersObj[name]) }));
  }

  function decodeBase64(b64) {
    if (!b64) return '';
    // Malformed base64 (bad chars/length) makes atob throw — catch it and keep
    // the raw payload rather than let one bad body drop the whole call.
    let bin;
    try {
      bin = atob(b64);
    } catch (e) {
      return b64;
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return null; // binary payload — not valid UTF-8
    }
  }

  /**
   * Network.requestWillBeSent -> pending record, or null when the event carries
   * no usable request/url.
   */
  function requestStart(params) {
    const req = params && params.request;
    if (!req || !req.url) return null;
    return {
      method: req.method || 'GET',
      url: req.url,
      requestHeaders: headersToArray(req.headers),
      postData: (req.postData && String(req.postData)) || null,
      wallTime: params.wallTime || 0
    };
  }

  /** Network.responseReceived -> merge status + response headers into the record. */
  function responseReceived(record, params) {
    const res = params && params.response;
    if (!record || !res) return;
    record.status = res.status != null ? res.status : null;
    record.responseHeaders = headersToArray(res.headers);
  }

  /**
   * Network.loadingFinished (or failed body fetch) -> final apiCall.
   * body/base64Encoded come from Network.getResponseBody; on failure pass null.
   * Text bodies decode to strings; binary payloads keep their raw base64 so the
   * session never stores UTF-8 mojibake.
   */
  function finish(record, body, base64Encoded) {
    let responseBody = body || null;
    if (base64Encoded) {
      const decoded = decodeBase64(body || '');
      responseBody = decoded === null ? (body || '') : decoded;
    }
    return {
      method: record.method || 'GET',
      url: record.url || '',
      status: record.status != null ? record.status : null,
      requestHeaders: record.requestHeaders || [],
      responseHeaders: record.responseHeaders || [],
      requestBody: record.postData || null,
      responseBody: responseBody,
      errorText: record.errorText || null, // from Network.loadingFailed, when present
      ts: record.wallTime ? Math.round(record.wallTime * 1000) : Date.now()
    };
  }

  return {
    requestStart: requestStart,
    responseReceived: responseReceived,
    finish: finish
  };
});