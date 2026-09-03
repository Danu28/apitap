'use strict';
// ApiTap util regression tests — run with: node apitap.test.js
const assert = require('assert');
const NoiseFilter = require('./utils/filter.js');
const Correlator = require('./utils/correlation.js');
const Exporter = require('./utils/postman.js');
const DebugCapture = require('./utils/debugcapture.js');

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
t('tracking params stripped', () => {
  assert.strictEqual(NoiseFilter.stripTrackingParams('https://x.com/a?utm_source=x&real=1&gclid=y'), 'https://x.com/a?real=1');
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
  c.addCall({ method: 'GET', url: 'https://api.x.com/users?page=2&filter=active#top', status: 200, ts: 1000,
    requestHeaders: [{ name: 'Authorization', value: 'Bearer tkn12345' }] });
  c.addCall({ method: 'POST', url: 'https://api.x.com/users', status: 201, ts: 3500,
    requestBody: '{"name":"bob"}' });
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

t('nothing checked -> empty collection, still valid JSON', () => {
  const c = new Correlator();
  c.addCall({ method: 'GET', url: 'https://api.x.com/users', ts: 1000 });
  c.setChecked('c1', false);
  const col = Exporter.buildCollection(c);
  assert.strictEqual(col.item.length, 0);
  JSON.parse(JSON.stringify(col));
});

console.log(process.exitCode ? 'FAILURES PRESENT' : 'ALL TESTS PASSED');