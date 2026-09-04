'use strict';
// ApiTap util regression tests — run with: node apitap.test.js
const assert = require('assert');
const NoiseFilter = require('./utils/filter.js');
const Correlator = require('./utils/correlation.js');
const Exporter = require('./utils/postman.js');
const DebugCapture = require('./utils/debugcapture.js');
const Tree = require('./utils/tree.js');

const t = (name, fn) => {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '-', e.message); process.exitCode = 1; }
};

/* ---- filter ---- */
t('telemetry + assets are noise, API calls are not', () => {
  assert(NoiseFilter.isNoise({ url: 'https://www.google-analytics.com/collect' }));
  assert(NoiseFilter.isNoise({ url: 'https://o123.ingest.sentry.io/api/42/envelope/' }));
  assert(NoiseFilter.isNoise({ url: 'https://x.com/app.css' }));
  assert(NoiseFilter.isNoise({ url: 'https://x.com/app.js' })); // .js extension now covered
  assert(NoiseFilter.isNoise({ url: 'https://x.com/pixel.png' }));
  assert(!NoiseFilter.isNoise({ url: 'https://api.x.com/v1/users' }));
});
t('host matching is exact/subdomain only — junk entries purged', () => {
  assert(!NoiseFilter.isNoise({ url: 'https://api.1stdibsdata.com/v1/items' }));
  assert(!NoiseFilter.isNoise({ url: 'https://my-gtag-host.com/x' }));
  assert(!NoiseFilter.isNoise({ url: 'https://shop.1stdibs.com/api' }));
  assert(NoiseFilter.isNoise({ url: 'https://sub.sentry.io/ingest' })); // real subdomain still drops
});
t('crashlytics.com and googlesyndication.com telemetry are flagged', () => {
  assert(NoiseFilter.isNoise({ url: 'https://crashlytics.com/report' }));
  assert(NoiseFilter.isNoise({ url: 'https://firebase-settings.crashlytics.com/x' }));
  assert(NoiseFilter.isNoise({ url: 'https://pagead2.googlesyndication.com/pagead/ads' }));
  assert(NoiseFilter.isNoise({ url: 'https://www.googletagmanager.com/gtm.js' }));
});
t('filterReason classifies drops', () => {
  const mk = (url, ct) => ({ url: url, responseHeaders: ct ? [{ name: 'Content-Type', value: ct }] : [] });
  assert.strictEqual(NoiseFilter.filterReason(mk('https://x.com/app.css')), 'asset-extension');
  assert.strictEqual(NoiseFilter.filterReason(mk('https://x.com/data', 'image/png')), 'asset-content-type');
  assert.strictEqual(NoiseFilter.filterReason(mk('https://www.google-analytics.com/collect')), 'telemetry');
  assert.strictEqual(NoiseFilter.filterReason(mk('https://api.x.com/v1/users', 'application/json')), null);
});
t('noise stats still count stored noise; mergeState keeps noise unchecked', () => {
  const c = new Correlator();
  for (let i = 0; i < 3; i++) c.addCall({ method: 'GET', url: 'https://x.com/pixel' + i + '.png', ts: i * 2000 + 1 });
  assert.strictEqual(c.filtered, 3);
  assert.strictEqual(c.calls.length, 3);
  const restored = new Correlator();
  restored.mergeState(c.serialize());
  assert(restored.calls.every((x) => x.checked === false && x.noiseReason === 'asset-extension'));
});
t('tracking params are preserved (capture truth, no silent mutation)', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/a?utm_source=x&real=1&gclid=y', ts: 1000 });
  assert.strictEqual(c.calls[0].url, 'https://api.x.com/a?utm_source=x&real=1&gclid=y');
});
t('malformed Content-Type header (no value) does not throw and keeps call as API', () => {
  const call = { url: 'https://api.x.com/data', responseHeaders: [{ name: 'Content-Type' }] };
  assert.doesNotThrow(() => NoiseFilter.filterReason(call));
  assert.strictEqual(NoiseFilter.filterReason(call), null); // not classified as asset noise
});

/* ---- engine ---- */
t('burst duplicates drop; noise calls are stored unchecked, others checked', () => {
  const c = new Correlator();
  const first = c.addCall({ method: 'GET', url: 'https://api.x.com/users', status: 200, ts: 1000 });
  assert.strictEqual(c.addCall({ method: 'GET', url: 'https://api.x.com/users', status: 200, ts: 1100 }), null); // burst dedupe
  assert.strictEqual(c.deduped, 1);
  const noise = c.addCall({ method: 'GET', url: 'https://x.com/pixel.png', ts: 1200 });
  assert.notStrictEqual(noise, null);           // stored, not discarded
  assert.strictEqual(noise.checked, false);     // unchecked by default
  assert.strictEqual(noise.noiseReason, 'asset-extension');
  assert.strictEqual(noise.responseBody, null); // noise bodies skipped
  assert.strictEqual(c.filtered, 1);
  assert.strictEqual(first.checked, true);
});
t('noise calls are user-selectable: checking one includes it in the export', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', ts: 1000 });
  const noise = c.addCall({ method: 'GET', url: 'https://opencode.ai/_server?id=1', ts: 3000,
    responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }] });
  assert.strictEqual(noise.checked, false);
  const col = Exporter.buildCollection(c);
  assert.strictEqual(col.item.length, 1); // noise excluded by default
  c.setChecked(noise.id, true);
  const col2 = Exporter.buildCollection(c);
  assert.strictEqual(col2.item.length, 2);
  assert(col2.item.some((f) => f.name === 'GET /_server'));
});
t('groups derived by method+host+path; query is collapsed', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', status: 200, ts: 1000 });
  c.addCall({ method: 'GET', url: 'https://api.x.com/users?page=2', status: 200, ts: 3000 });
  c.addCall({ method: 'POST', url: 'https://api.x.com/users', status: 201, ts: 5000 });
  c.addCall({ method: 'GET', url: 'https://api.x.com/orders', status: 200, ts: 7000 });
  const g = c.groups();
  assert.strictEqual(g.size, 3);
  assert.strictEqual(g.get('GET|api.x.com|/users').calls.length, 2);
  assert.strictEqual(c.getStats().groups, 3);
});
t('tree build groups domains->endpoints; tri-state aggregates', () => {
  const calls = [
    { id: 'c1', method: 'GET', url: 'https://api.x.com/users', status: 200, checked: true, groupKey: 'GET|api.x.com|/users' },
    { id: 'c2', method: 'GET', url: 'https://api.x.com/users?p=2', status: 200, checked: false, groupKey: 'GET|api.x.com|/users' },
    { id: 'c3', method: 'POST', url: 'https://api.x.com/users', status: 201, checked: true, groupKey: 'POST|api.x.com|/users' },
    { id: 'c4', method: 'GET', url: 'https://cdn.x.com/x.png', status: 200, checked: false, groupKey: 'GET|cdn.x.com|/x.png' },
    { id: 'c5', method: 'GET', url: 'not a url', status: 0, checked: true, groupKey: 'unparseable' }
  ];
  const domains = Tree.buildDomainTree(calls);
  assert.strictEqual(domains.length, 3); // api.x.com, cdn.x.com, unparseable
  const api = domains.find((d) => d.host === 'api.x.com');
  assert.strictEqual(api.endpoints.size, 2);
  const partial = Tree.selectionState(api.endpoints.get('GET|api.x.com|/users'));
  assert.strictEqual(partial.all, false); assert.strictEqual(partial.some, true); assert.strictEqual(partial.checked, 1);
  const full = Tree.selectionState(api.endpoints.get('POST|api.x.com|/users'));
  assert.strictEqual(full.all, true);
  const none = Tree.selectionState(api.endpoints.get('GET|api.x.com|/orders') || []);
  assert.strictEqual(none.none, true);
  assert.strictEqual(Tree.hostOf('unparseable'), 'unparseable');
  assert.strictEqual(Tree.groupLabel('GET|api.x.com|/orders'), '/orders');
});
t('buildDomainTree accepts an injected host extractor', () => {
  const domains = Tree.buildDomainTree([{ groupKey: 'x' }], () => 'custom');
  assert.strictEqual(domains.length, 1);
  assert.strictEqual(domains[0].host, 'custom');
  assert.strictEqual(domains[0].endpoints.size, 1);
});
t('malformed URL lands in the unparseable group, never throws', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'not a url', status: 0, ts: 1 });
  assert.strictEqual(c.groupKey(c.calls[0]), 'unparseable');
  assert.strictEqual(c.getStats().groups, 1);
  assert.strictEqual(c.getStats().calls, 1);
});
t('setChecked toggles a single call by id and a whole group by key', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', ts: 1000 });
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', ts: 3000 });
  c.addCall({ method: 'GET', url: 'https://api.x.com/orders', ts: 5000 });
  assert.strictEqual(c.setChecked('c2', false), 1);
  assert.strictEqual(c.calls[1].checked, false);
  assert.strictEqual(c.setChecked('GET|api.x.com|/users', true), 2); // group toggle re-checks all
  assert(c.calls.every((x) => x.checked === true));
  assert.strictEqual(c.setChecked('no-such-id-or-group', false), 0);
});
t('checked state survives serialize/mergeState round-trip', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', ts: 1000 });
  c.setChecked('c1', false);
  const restored = new Correlator();
  restored.mergeState(c.serialize());
  assert.strictEqual(restored.calls.length, 1);
  assert.strictEqual(restored.calls[0].checked, false);
  assert.strictEqual(restored.calls[0].id, 'c1');
});
t('old persisted calls without the checked field default to checked', () => {
  const restored = new Correlator();
  restored.mergeState({ calls: [{ id: 'c1', method: 'GET', url: 'https://api.x.com/users', ts: 1 }] });
  assert.strictEqual(restored.calls[0].checked, true);
});

/* ---- exporter ---- */
t('collection exports only checked calls, one folder per group, valid v2.1', () => {
  const c = new Correlator();
  c.addCall({ method: 'POST', url: 'https://api.x.com/login', status: 200, ts: 1000,
    requestBody: '{"user":"a"}' });
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', status: 200, ts: 3000,
    requestHeaders: [
      { name: 'Cookie', value: 'sid=abc123' },
      { name: 'Authorization', value: 'Bearer tok' },
      { name: 'Accept', value: 'application/json' },
      { name: 'Accept-Encoding', value: 'gzip' }
    ] });
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', status: 200, ts: 5000 });
  c.setChecked('c3', false);
  const col = Exporter.buildCollection(c);
  assert.strictEqual(col.info.schema, Exporter.COLLECTION_SCHEMA);
  assert.strictEqual(col.item.length, 2); // login + users; c3 excluded from users group
  const users = col.item.find((f) => f.name === 'GET /users');
  assert.strictEqual(users.item.length, 1);
  const usersReq = users.item[0].request;
  assert(usersReq.url.raw.includes('{{baseUrl}}'));
  const headers = JSON.stringify(usersReq.header);
  assert(!headers.toLowerCase().includes('cookie'), 'cookies must never be exported');
  assert(headers.includes('Authorization'));
  assert(!headers.includes('Accept-Encoding'));
  JSON.parse(JSON.stringify(col)); // must serialize
});
t('export is Postman-native: URL breakdown, params, auth, valid variable type', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users?page=2&filter=active#top', status: 200, ts: 1000, requestHeaders: [{ name: 'Authorization', value: 'Bearer tkn12345' }] });
  c.addCall({ method: 'POST', url: 'https://api.x.com/users', status: 201, ts: 3500, requestBody: '{"name":"bob"}' });
  const col = Exporter.buildCollection(c);
  assert.strictEqual(col.variable[0].type, 'string'); // v2.1 enum, not 'default'
  const get = col.item.find((f) => f.name === 'GET /users').item[0];
  assert.strictEqual(get.request.method, 'GET');
  assert.strictEqual(get.request.url.raw, '{{baseUrl}}/users?page=2&filter=active#top');
  assert.strictEqual(get.request.url.protocol, 'https');
  assert.deepStrictEqual(get.request.url.host, ['api', 'x', 'com']);
  assert.deepStrictEqual(get.request.url.path, ['users']);
  assert.deepStrictEqual(get.request.url.query, [{ key: 'page', value: '2' }, { key: 'filter', value: 'active' }]);
  assert.strictEqual(get.request.url.hash, 'top');
  assert.deepStrictEqual(get.request.url.variable, [{ key: 'baseUrl', value: 'https://api.x.com' }]);
  assert.strictEqual(get.request.auth.type, 'bearer');
  assert.strictEqual(get.request.auth.bearer[0].value, 'tkn12345');
  assert(Array.isArray(get.response), 'items carry a response array like Postman exports');
  const post = col.item.find((f) => f.name === 'POST /users').item[0];
  assert.strictEqual(post.request.body.mode, 'raw');
  assert.strictEqual(post.request.url.host[0], 'api');
});
t('origin substitution is prefix-only; query values keep the base-origin literal', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/login?redirect_uri=https://api.x.com/cb', status: 200, ts: 1000 });
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', status: 200, ts: 2000 });
  const col = Exporter.buildCollection(c);
  const login = col.item.find((f) => f.name === 'GET /login').item[0];
  assert.strictEqual(login.request.url.raw, '{{baseUrl}}/login?redirect_uri=https://api.x.com/cb');
  // A foreign-origin URL is never touched by the most-common baseUrl.
  c.addCall({ method: 'GET', url: 'https://auth.x.com/go?next=https://api.x.com/users', status: 200, ts: 3000 });
  const col2 = Exporter.buildCollection(c);
  const auth = col2.item.find((f) => f.name === 'GET /go').item[0];
  assert.strictEqual(auth.request.url.raw, 'https://auth.x.com/go?next=https://api.x.com/users');
});

t('debugger events map to an apiCall (incl. base64 body decode)', () => {
  const rec = DebugCapture.requestStart({
    requestId: 'r1', wallTime: 1700000000.123,
    request: { method: 'POST', url: 'https://api.x.com/login', postData: '{"u":"a"}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tkn' } }
  });
  assert.notStrictEqual(rec, null);
  DebugCapture.responseReceived(rec, { response: { status: 200, headers: { 'Content-Type': 'application/json' } } });
  const call = DebugCapture.finish(rec, btoa('{"token":"tok123"}'), true);
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.status, 200);
  assert.deepStrictEqual(call.requestHeaders, [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Authorization', value: 'Bearer tkn' }
  ]);
  assert.strictEqual(call.requestBody, '{"u":"a"}');
  assert.strictEqual(call.responseBody, '{"token":"tok123"}');
  assert.strictEqual(call.ts, 1700000000123);
});
t('requestStart rejects url-less events; finish tolerates missing body', () => {
  assert.strictEqual(DebugCapture.requestStart({ request: {} }), null);
  const rec = DebugCapture.requestStart({ request: { url: 'https://x.com/noresp', method: 'GET' } });
  const call = DebugCapture.finish(rec, null, false);
  assert.strictEqual(call.responseBody, null);
  assert.strictEqual(call.responseHeaders.length, 0);
  assert.strictEqual(call.requestBody, null);
});
t('text base64 bodies still decode', () => {
  const rec = DebugCapture.requestStart({ request: { url: 'https://api.x.com/data', method: 'GET', headers: {} } });
  const call = DebugCapture.finish(rec, btoa('{"ok":1}'), true);
  assert.strictEqual(call.responseBody, '{"ok":1}');
});
t('binary base64 bodies keep raw base64, no mojibake', () => {
  const rec = DebugCapture.requestStart({ request: { url: 'https://api.x.com/file.pdf', method: 'GET', headers: {} } });
  const b64 = btoa('\x89PNG\r\n\x1a\n' + '\x00'.repeat(8)); // not valid UTF-8
  const call = DebugCapture.finish(rec, b64, true);
  assert.strictEqual(call.responseBody, b64);
  const c = new Correlator();
  c.addCall(call);
  assert.strictEqual(c.calls[0].responseBody, b64);
});
t('malformed base64 body keeps the raw payload; the call is not lost', () => {
  const rec = DebugCapture.requestStart({ request: { url: 'https://api.x.com/broken-base64', method: 'GET', headers: {} } });
  const bad = '!!!not::base64!!!'; // atob throws on this input
  const call = DebugCapture.finish(rec, bad, true);
  assert.strictEqual(call.responseBody, bad); // raw kept, never a throw
  assert.strictEqual(call.url, 'https://api.x.com/broken-base64');
});

t('a captured debugger call flows into engine grouping + export (params intact)', () => {
  const c = new Correlator();
  const rec = DebugCapture.requestStart({ request: { url: 'https://api.x.com/users?page=2', method: 'GET', headers: {} } });
  DebugCapture.responseReceived(rec, { response: { status: 200, headers: { 'Content-Type': 'application/json' } } });
  c.addCall(DebugCapture.finish(rec, '{"ok":true}', false));
  const col = Exporter.buildCollection(c);
  const folder = col.item.find((f) => f.name === 'GET /users');
  assert(folder);
  assert.deepStrictEqual(folder.item[0].request.url.query, [{ key: 'page', value: '2' }]);
});

t('export filenames are meaningful + unique', () => {
  const col = { variable: [{ key: 'baseUrl', value: 'https://api.shop.com' }] };
  const t1 = new Date(2026, 8, 3, 19, 30, 11);
  const t2 = new Date(2026, 8, 3, 19, 30, 12);
  const f1 = Exporter.suggestFilename(col, t1);
  assert.strictEqual(f1, 'apitap-api-shop-com-20260903-193011.json');
  assert.notStrictEqual(f1, Exporter.suggestFilename(col, t2)); // timestamp makes each export unique
  assert(Exporter.suggestFilename({ variable: [] }, t1).startsWith('apitap-session-')); // no host fallback
});
t('nothing checked -> empty collection, still valid JSON', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', ts: 1000 });
  c.setChecked('c1', false);
  const col = Exporter.buildCollection(c);
  assert.strictEqual(col.item.length, 0);
  JSON.parse(JSON.stringify(col));
});

console.log(process.exitCode ? 'FAILURES PRESENT' : 'ALL TESTS PASSED');