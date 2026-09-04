/**
 * ApiTap — FlowTree
 * Pure helpers for the popup's Domain → Endpoint → Request hierarchy:
 *   - hostOf: host segment of a group key (METHOD|host|path)
 *   - buildDomainTree: ordered tree from the flat calls list
 *   - selectionState: aggregate checked state (full / partial / none)
 *   - groupLabel: human endpoint label from a group key
 * No DOM, no chrome APIs — unit-testable in Node.
 * Dual-exported for the popup (globalThis) and Node tests (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ApiTapTree = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Host of a group key (METHOD|host|path); unparseable keys group under themselves. */
  function hostOf(key) {
    const p = String(key || '').split('|');
    return p.length === 3 ? p[1] : key;
  }

  /**
   * Ordered Domain -> Endpoint -> Request tree from the flat calls list.
   * Each domain: { host, endpoints: Map<groupKey, calls> }.
   * @param {Array} calls     calls, each carrying a `groupKey`
   * @param {Function} [getHost] injectable host extractor (defaults to hostOf)
   */
  function buildDomainTree(calls, getHost) {
    const h = getHost || hostOf;
    const domains = new Map(); // host -> { host, endpoints: Map<groupKey, calls> }
    for (const call of calls || []) {
      const key = call.groupKey || 'unparseable';
      const host = h(key);
      if (!domains.has(host)) domains.set(host, { host: host, endpoints: new Map() });
      const endpoints = domains.get(host).endpoints;
      if (!endpoints.has(key)) endpoints.set(key, []);
      endpoints.get(key).push(call);
    }
    return [...domains.values()];
  }

  /** Aggregate selection over a list of calls: full / partial / none. */
  function selectionState(calls) {
    const total = calls.length;
    let checked = 0;
    for (const call of calls) if (call.checked !== false) checked++;
    return {
      checked: checked,
      all: total > 0 && checked === total,
      some: checked > 0,
      none: checked === 0
    };
  }

  /** Endpoint label from a group key (METHOD|host|path) — falls back to the key. */
  function groupLabel(key) {
    const p = String(key || '').split('|');
    return p.length === 3 ? (p[2] || p[1]) : key;
  }

  return {
    hostOf: hostOf,
    buildDomainTree: buildDomainTree,
    selectionState: selectionState,
    groupLabel: groupLabel
  };
});