/**
 * ApiTap — PostmanExporter
 * Turns a filtered, checked session into a Postman v2.1 collection:
 *   - one folder per endpoint group
 *   - full URL breakdown per request: protocol, host, path, query params, hash
 *   - {{baseUrl}} collection variable (most common origin)
 *   - structured auth (bearer/basic) recognized from the Authorization header
 *   - transport/noise headers dropped; cookies never exported (recorded
 *     cookies are stale session state that would break replay, not test data)
 * Pure data -> object; no DOM, no chrome APIs.
 * Dual-exported for the service worker (globalThis) and Node tests (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.PostmanExporter = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

  // Headers we drop (transport / noise / stale credentials): cookie included.
  const DROP_HEADERS = new Set([
    'host', 'content-length', 'connection', 'accept-encoding', 'user-agent',
    'origin', 'referer', 'referrer', 'pragma', 'sec-fetch-site', 'sec-fetch-mode',
    'sec-fetch-dest', 'sec-fetch-user', 'sec-ch-ua', 'sec-ch-ua-mobile',
    'sec-ch-ua-platform', 'upgrade-insecure-requests', 'dnt', 'cookie'
  ]);

  function commonOrigin(urls) {
    const tally = {};
    for (const u of urls) {
      if (!u) continue;
      try {
        const origin = new URL(u).origin;
        tally[origin] = (tally[origin] || 0) + 1;
      } catch (e) {}
    }
    let best = null, bestCount = 0;
    for (const o of Object.keys(tally)) {
      if (tally[o] > bestCount) { best = o; bestCount = tally[o]; }
    }
    return best; // most-common origin, or null
  }

  function lastPathSegment(url) {
    try {
      const u = new URL(url);
      const segs = u.pathname.split('/').filter(Boolean);
      return segs.length ? segs[segs.length - 1] : u.hostname;
    } catch (e) { return 'request'; }
  }

  function headerEntry(header) {
    if (!header || (!header.name && !header.key)) return null;
    const name = header.name || header.key;
    return { key: name, value: header.value != null ? header.value : '' };
  }

  /** Deterministic selected request headers: noise dropped, dupes merged. */
  function pickHeaders(call) {
    const kept = [];
    const seen = {};
    const src = call.requestHeaders || [];
    for (const h of src) {
      const e = headerEntry(h);
      if (!e) continue;
      const name = e.key.toLowerCase();
      if (DROP_HEADERS.has(name) || seen[name]) continue;
      seen[name] = true;
      kept.push(e);
    }
    return kept;
  }

  function requestBodyMode(raw) {
    const cleaned = raw || '';
    if (!cleaned) return null;
    let language = 'text';
    try { JSON.parse(cleaned); language = 'json'; } catch (e) {}
    return { mode: 'raw', raw: cleaned, options: { raw: { language: language } } };
  }

  function groupLabel(key) {
    const parts = key.split('|');
    if (parts.length !== 3) return key;
    return parts[0] + ' ' + (parts[2] || parts[1]);
  }

  /**
   * Postman-native URL object: { raw, protocol, host[], path[], query[], hash, variable[] }.
   * raw keeps the {{baseUrl}}-substituted form (the send truth); the breakdown
   * is parsed from the concrete URL so Postman's UI shows params/tabs.
   */
  function buildUrlObject(callUrl, baseUrl) {
    let raw = callUrl || '';
    let substituted = false;
    try {
      const origin = new URL(callUrl).origin;
      // Substitute only the call's own origin when it matches the collection's
      // baseUrl — and only as a prefix (never inside query params). A secondary
      // origin (e.g. an auth host) must keep its absolute URL, not be rewritten
      // to baseUrl's host.
      if (origin && baseUrl && origin === baseUrl && raw.startsWith(origin)) {
        raw = '{{baseUrl}}' + raw.slice(origin.length);
        substituted = true;
      }
    } catch (e) {}
    const urlObj = { raw: raw };
    try {
      const u = new URL(callUrl);
      urlObj.protocol = u.protocol.replace(/:$/, '');
      urlObj.host = u.hostname.split('.');
      const defaultPort = u.protocol === 'https:' ? '443' : '80';
      if (u.port && u.port !== defaultPort) urlObj.port = u.port;
      if (u.pathname) urlObj.path = u.pathname.split('/').filter(Boolean);
      if (u.search) {
        urlObj.query = [];
        for (const key of new Set(u.searchParams.keys())) {
          for (const value of u.searchParams.getAll(key)) urlObj.query.push({ key: key, value: value });
        }
      }
      if (u.hash) urlObj.hash = u.hash.replace(/^#/, '');
      if (substituted && baseUrl) urlObj.variable = [{ key: 'baseUrl', value: baseUrl }];
    } catch (e) { /* malformed URL: a raw-only url object is still schema-valid */ }
    return urlObj;
  }

  /**
   * Structured Postman auth helper when the captured Authorization header is a
   * recognizable bearer or basic token. The header itself is still exported
   * (same value), so the sent request is unchanged either way.
   */
  function authSection(call) {
    for (const h of call.requestHeaders || []) {
      const e = headerEntry(h);
      if (!e || e.key.toLowerCase() !== 'authorization') continue;
      const v = String(e.value || '');
      const bearer = /^Bearer\s+(.+)$/i.exec(v);
      if (bearer) return { type: 'bearer', bearer: [{ key: 'token', value: bearer[1], type: 'string' }] };
      const basic = /^Basic\s+(.+)$/i.exec(v);
      if (basic) {
        let decoded = null;
        try { decoded = atob(basic[1]); } catch (err) {}
        if (decoded && decoded.indexOf(':') !== -1) {
          const sep = decoded.indexOf(':');
          return {
            type: 'basic',
            basic: [
              { key: 'username', value: decoded.slice(0, sep), type: 'string' },
              { key: 'password', value: decoded.slice(sep + 1), type: 'string' }
            ]
          };
        }
      }
    }
    return null;
  }

  function buildRequestItem(call, baseUrl) {
    const method = call.method || 'GET';
    const request = {
      method: method,
      header: pickHeaders(call),
      url: buildUrlObject(call.url, baseUrl)
    };
    const auth = authSection(call);
    if (auth) request.auth = auth;
    const body = requestBodyMode(call.requestBody || null);
    if (body) request.body = body;
    return { name: method + ' ' + lastPathSegment(call.url), request: request, response: [] };
  }

  /**
   * Collection of the checked calls, one folder per endpoint group.
   */
  function buildCollection(correlator) {
    const calls = (correlator.calls || []).filter((c) => c.checked !== false);
    const baseUrl = commonOrigin(calls.map((c) => c.url));

    const groups = new Map();
    for (const call of calls) {
      const key = correlator.groupKey(call);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }

    const item = [];
    for (const [key, list] of groups) {
      item.push({ name: groupLabel(key), item: list.map((c) => buildRequestItem(c, baseUrl)) });
    }

    const collectionVars = [];
    if (baseUrl) collectionVars.push({ key: 'baseUrl', value: baseUrl, type: 'string' });

    return {
      info: {
        name: 'ApiTap — Recorded flow',
        description: 'Recreates recorded test data via the API. Set {{baseUrl}} (and any auth) in Postman before running.',
        schema: COLLECTION_SCHEMA
      },
      item: item,
      variable: collectionVars
    };
  }

  /**
   * Meaningful, unique export filename: apitap-<origin-host>-<local-ts>.json.
   * Host comes from the collection's baseUrl variable; 'session' when absent.
   */
  function suggestFilename(collection, now) {
    const t = now || new Date();
    const p = (n) => String(n).padStart(2, '0');
    let host = '';
    const baseUrl = ((collection && collection.variable) || []).find((v) => v.key === 'baseUrl');
    if (baseUrl && baseUrl.value) {
      try {
        host = new URL(baseUrl.value).hostname.replace(/[^a-z0-9-]/gi, '-');
      } catch (e) {}
    }
    const stamp = t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' +
      p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
    return 'apitap-' + (host || 'session') + '-' + stamp + '.json';
  }

  return {
    COLLECTION_SCHEMA: COLLECTION_SCHEMA,
    suggestFilename: suggestFilename,
    buildCollection: buildCollection
  };
});