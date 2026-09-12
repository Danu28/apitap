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
  // When keepOrigin is true, these are NOT dropped
  const KEEPABLE = new Set(['origin', 'referer', 'referrer']);

  const SENSITIVE_QUERY_KEYS = new Set(['token','access_token','api_key','apikey','auth','authorization','key','secret','password','passwd']);
  function redactQueryParams(url, doRedact) {
    if (!doRedact || !url) return url;
    try {
      const u = new URL(url);
      let changed = false;
      for (const k of [...u.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) { u.searchParams.set(k, '{{authToken}}'); changed = true; }
      }
      if (!changed) return url;
      let s = u.toString();
      // keep Postman variable un-encoded
      s = s.replace(/%7B%7BauthToken%7D%7D/g, '{{authToken}}');
      return s;
    } catch (e) { return url; }
  }

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
    return best;
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
  function pickHeaders(call, opts) {
    const keepOrigin = opts && opts.keepOrigin;
    const redact = opts && opts.redactAuth;
    const kept = [];
    const seen = {};
    const src = call.requestHeaders || [];
    for (const h of src) {
      const e = headerEntry(h);
      if (!e) continue;
      const low = e.key.toLowerCase();
      if (low === 'cookie') continue; // never export cookies — invariant
      if (!keepOrigin && DROP_HEADERS.has(low)) continue;
      if (keepOrigin && DROP_HEADERS.has(low) && !KEEPABLE.has(low)) continue;
      if (seen[low]) continue;
      seen[low] = true;
      if (redact && low === 'authorization') {
        // replace token with variable placeholder, keep scheme
        var v = String(e.value || '');
        if (/^Bearer\s+/i.test(v)) e.value = 'Bearer {{authToken}}';
        else if (/^Basic\s+/i.test(v)) e.value = 'Basic {{authToken}}';
      }
      kept.push(e);
    }
    return kept;
  }

  function countDropped(call, opts) {
    var keepOrigin = opts && opts.keepOrigin;
    var n = 0;
    for (var i = 0; i < (call.requestHeaders || []).length; i++) {
      var h = headerEntry(call.requestHeaders[i]);
      if (!h) continue;
      var low = h.key.toLowerCase();
      if (low === 'cookie') { n++; continue; }
      if (!keepOrigin && DROP_HEADERS.has(low)) n++;
      else if (keepOrigin && DROP_HEADERS.has(low) && !KEEPABLE.has(low)) n++;
    }
    return n;
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

  function buildUrlObject(callUrl, baseUrl, opts) {
    const redactQ = opts && opts.redactQueryTokens;
    let effectiveUrl = redactQ ? redactQueryParams(callUrl, true) : callUrl;
    let raw = effectiveUrl || '';
    let substituted = false;
    try {
      const origin = new URL(effectiveUrl).origin;
      if (origin && baseUrl && origin === baseUrl && raw.startsWith(origin)) {
        raw = '{{baseUrl}}' + raw.slice(origin.length);
        substituted = true;
      }
    } catch (e) {}
    const urlObj = { raw: raw };
    try {
      const u = new URL(effectiveUrl);
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
    } catch (e) {}
    return urlObj;
  }

  function authSection(call, opts) {
    var redact = opts && opts.redactAuth;
    for (const h of call.requestHeaders || []) {
      const e = headerEntry(h);
      if (!e || e.key.toLowerCase() !== 'authorization') continue;
      const v = String(e.value || '');
      if (redact) return { type: 'bearer', bearer: [{ key: 'token', value: '{{authToken}}', type: 'string' }] };
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

  function buildResponseExample(call) {
    if (!call.responseBody) return null;
    var ct = '';
    for (var i = 0; i < (call.responseHeaders || []).length; i++) {
      var h = call.responseHeaders[i];
      if (h && h.name && String(h.name).toLowerCase() === 'content-type') { ct = String(h.value || '').split(';')[0].trim(); break; }
    }
    var body = call.responseBody;
    var isJson = false;
    try { JSON.parse(body); isJson = true; } catch (e) {}
    return {
      name: 'Example ' + (call.status != null ? call.status : 'response'),
      originalRequest: {
        method: call.method || 'GET',
        header: pickHeaders(call, {}),
        url: buildUrlObject(call.url, null, {}),
        body: requestBodyMode(call.requestBody || null)
      },
      status: String(call.status != null ? call.status : 'OK'),
      code: call.status != null ? call.status : 200,
      _postman_previewlanguage: isJson ? 'json' : 'text',
      header: call.responseHeaders ? call.responseHeaders.map(function (hh) { return { key: hh.name || hh.key || '', value: hh.value != null ? String(hh.value) : '', name: hh.name || hh.key || '' }; }) : [],
      body: body,
      cookie: []
    };
  }

  function buildRequestItem(call, baseUrl, opts) {
    const method = call.method || 'GET';
    const request = {
      method: method,
      header: pickHeaders(call, opts),
      url: buildUrlObject(call.url, baseUrl, opts)
    };
    if (opts && opts.droppedCount) request.description = 'headers dropped: ' + opts.droppedCount;
    const auth = authSection(call, opts);
    if (auth) request.auth = auth;
    const body = requestBodyMode(call.requestBody || null);
    if (body) request.body = body;
    var example = (opts && opts.includeExamples !== false) ? buildResponseExample(call) : null;
    var responses = [];
    if (example && call.responseBody) responses.push(example);
    return { name: method + ' ' + lastPathSegment(call.url), request: request, response: responses };
  }

  function buildCollection(correlator, opts) {
    opts = opts || {};
    const calls = (correlator.calls || []).filter((c) => c.checked !== false);
    const effBase = opts.baseUrlOverride || commonOrigin(calls.map((c) => c.url));
    const baseUrl = effBase;
    const groups = new Map();
    for (const call of calls) {
      const key = correlator.groupKey(call);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }
    const item = [];
    for (const [key, list] of groups) {
      // folder description: counts + status distribution
      var dist = {};
      for (var i = 0; i < list.length; i++) { var s = list[i].status != null ? String(list[i].status) : 'pending'; dist[s] = (dist[s] || 0) + 1; }
      var dparts = [];
      for (var k in dist) dparts.push(dist[k] + ' × ' + k);
      var folderDesc = list.length + ' request(s) · ' + dparts.join(', ');
      var gDropped = 0;
      for (var j = 0; j < list.length; j++) gDropped += countDropped(list[j], opts);
      if (gDropped) folderDesc += ' · ' + gDropped + ' header(s) dropped';
      item.push({
        name: groupLabel(key),
        description: folderDesc,
        item: list.map((c) => buildRequestItem(c, baseUrl, { keepOrigin: !!opts.keepOrigin, redactAuth: !!opts.redactAuth, redactQueryTokens: !!opts.redactQueryTokens, includeExamples: opts.includeExamples !== false, droppedCount: countDropped(c, opts) }))
      });
    }
    const collectionVars = [];
    if (baseUrl) collectionVars.push({ key: 'baseUrl', value: baseUrl, type: 'string' });
    if (opts.redactAuth) {
      // add authToken placeholder if any auth was present
      var hasAuth = calls.some(function (c) { return (c.requestHeaders || []).some(function (h){ var e=headerEntry(h); return e && e.key.toLowerCase()==='authorization'; }); });
      if (hasAuth) collectionVars.push({ key: 'authToken', value: 'REPLACE_ME', type: 'string' });
    }
    return {
      info: {
        name: opts.collectionName || 'ApiTap — Recorded flow',
        description: 'Recreates recorded test data via the API. Set {{baseUrl}} (and any auth) in Postman before running.',
        schema: COLLECTION_SCHEMA
      },
      item: item,
      variable: collectionVars
    };
  }

  function buildEnvironment(correlator, opts) {
    opts = opts || {};
    var calls = (correlator.calls || []).filter(function (c) { return c.checked !== false; });
    var baseUrl = opts.baseUrlOverride || commonOrigin(calls.map(function (c) { return c.url; }));
    var values = [];
    if (baseUrl) values.push({ key: 'baseUrl', value: baseUrl, enabled: true, type: 'text' });
    // collect auth tokens
    var seen = {};
    for (var i = 0; i < calls.length; i++) {
      for (var j = 0; j < (calls[i].requestHeaders || []).length; j++) {
        var h = calls[i].requestHeaders[j];
        var e = headerEntry(h);
        if (!e || e.key.toLowerCase() !== 'authorization') continue;
        var v = String(e.value || '');
        if (!seen[v]) {
          seen[v] = true;
          var m = /^Bearer\s+(.+)$/i.exec(v);
          if (m) values.push({ key: 'authToken', value: opts.redactAuth ? 'REPLACE_ME' : m[1], enabled: true, type: 'text' });
        }
      }
    }
    return { id: 'apitap-env', name: opts.envName || 'ApiTap Env', values: values, _postman_variable_scope: 'environment', _postman_exported_at: new Date().toISOString(), _postman_exported_using: 'ApiTap' };
  }

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

  function suggestEnvFilename(collection, now) {
    return suggestFilename(collection, now).replace(/\.json$/, '.env.json');
  }

  return {
    COLLECTION_SCHEMA: COLLECTION_SCHEMA,
    suggestFilename: suggestFilename,
    suggestEnvFilename: suggestEnvFilename,
    buildCollection: buildCollection,
    buildEnvironment: buildEnvironment,
    pickHeaders: pickHeaders,
    countDropped: countDropped
  };
});
