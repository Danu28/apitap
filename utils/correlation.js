/**
 * ApiTap — Session engine
 * Ingests captured API calls: noise filtering, burst deduping, endpoint
 * grouping, and per-request checked state for export selection.
 * Filtering comes from filter.js (sibling util).
 * Dual-exported for the service worker (globalThis) and Node tests (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ApiTapCorrelator = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NoiseFilter = (typeof module !== 'undefined' && module.require)
    ? module.require('./filter.js')
    : globalThis.NoiseFilter;
  const MAX_BODY_CHARS = 200000; // ~200KB of text per body
  const DEDUPE_WINDOW_MS = 1500; // identical repeat within this window is a burst

  function Correlator() {
    this.calls = [];       // all stored calls; noise-qualified ones are unchecked
    this.filtered = 0;     // stored-noise count (visible in stats)
    this.deduped = 0;      // burst-duplicate count
    this.dedupeKeyToTs = new Map(); // fingerprint -> last ts (not persisted)
  }

  function truncateBody(str) {
    if (str == null) return str;
    if (typeof str !== 'string') str = String(str);
    if (str.length <= MAX_BODY_CHARS) return str;
    return str.slice(0, MAX_BODY_CHARS) + '\n// [ApiTap] truncated (' + str.length + ' chars total)';
  }

  /* ---------- ingestion ---------- */

  /**
   * Ingest one captured call. Returns the stored call, or null when it was a
   * burst duplicate. Noise calls (assets/telemetry) are NOT discarded — they
   * are stored unchecked so the user can decide whether to include them.
   */
  Correlator.prototype.addCall = function (rawCall) {
    const noiseReason = rawCall ? NoiseFilter.filterReason(rawCall) : 'no-url';

    // Burst-dedupe: same method|host|path|status within the window is a repeat.
    const fp = this.fingerprint(rawCall);
    const now = rawCall.ts || Date.now();
    const lastTs = this.dedupeKeyToTs.get(fp);
    if (lastTs != null && now - lastTs < DEDUPE_WINDOW_MS) {
      this.deduped++;
      return null;
    }
    this.dedupeKeyToTs.set(fp, now);

    if (noiseReason) this.filtered++;

    const call = {
      id: 'c' + (this.calls.length + 1),
      method: rawCall.method || 'GET',
      url: rawCall.url || '',
      status: rawCall.status != null ? rawCall.status : null,
      requestHeaders: rawCall.requestHeaders || [],
      responseHeaders: rawCall.responseHeaders || [],
      requestBody: truncateBody(rawCall.requestBody),
      // Noise bodies are skipped: base64 images/media would balloon the
      // session and are never useful for export.
      responseBody: noiseReason ? null : truncateBody(rawCall.responseBody),
      errorText: rawCall.errorText || null, // network failure reason, when present
      ts: now,
      checked: !noiseReason,
      noiseReason: noiseReason || undefined
    };
    this.calls.push(call);
    return call;
  };

  Correlator.prototype.fingerprint = function (call) {
    let host = '', path = '';
    try {
      const u = new URL(call.url || '');
      host = u.host;
      path = u.pathname;
    } catch (e) {}
    return (call.method || 'GET') + '|' + host + '|' + path + '|' + (call.status != null ? call.status : '');
  };

  /* ---------- grouping ---------- */

  // Endpoint key: method + host + path (query & hash excluded, so repeated
  // calls to the same endpoint collapse into one group).
  Correlator.prototype.groupKey = function (call) {
    try {
      const u = new URL(call.url || '');
      return (call.method || 'GET').toUpperCase() + '|' + u.host + '|' + u.pathname;
    } catch (e) {
      return 'unparseable'; // malformed URLs still surface, never throw
    }
  };

  /** Derived grouping in insertion order: groupKey -> { key, calls: [] }. */
  Correlator.prototype.groups = function () {
    const map = new Map();
    for (const call of this.calls) {
      const key = this.groupKey(call);
      if (!map.has(key)) map.set(key, { key: key, calls: [] });
      map.get(key).calls.push(call);
    }
    return map;
  };

  /* ---------- export selection ---------- */

  /**
   * Check/uncheck by call id or by group key (whole group).
   * Returns the number of calls updated (0 = nothing matched).
   */
  Correlator.prototype.setChecked = function (idOrGroupKey, checked) {
    if (!idOrGroupKey) return 0;
    const call = this.calls.find((c) => c.id === idOrGroupKey);
    if (call) {
      call.checked = !!checked;
      return 1;
    }
    let n = 0;
    for (const c of this.calls) {
      if (this.groupKey(c) === idOrGroupKey) { c.checked = !!checked; n++; }
    }
    return n;
  };

  /* ---------- stats ---------- */

  Correlator.prototype.getStats = function () {
    return {
      calls: this.calls.length,
      groups: this.groups().size,
      filtered: this.filtered,
      deduped: this.deduped
    };
  };

  /* ---------- persistence ---------- */

  Correlator.prototype.serialize = function () {
    return {
      calls: this.calls,
      filtered: this.filtered,
      deduped: this.deduped
    };
  };

  Correlator.prototype.mergeState = function (state) {
    if (!state) return;
    if (Array.isArray(state.calls)) this.calls = state.calls;
    if (typeof state.filtered === 'number') this.filtered = state.filtered;
    if (typeof state.deduped === 'number') this.deduped = state.deduped;
    // Persisted calls without an explicit checked state: noise defaults off,
    // everything else on.
    for (const call of this.calls) {
      if (typeof call.checked !== 'boolean') call.checked = !call.noiseReason;
    }
  };

  return Correlator;
});