# Progress

## Round 2026-09-03 — ApiTap v2 build (plan Revision 2026-09-03, all tasks)

T1. Slim utils/correlation.js → verify: apitap.test.js grouping + checked asserts pass — passed
   files: utils/correlation.js, apitap.test.js
T2. Trim utils/postman.js → verify: test — only checked calls, folders=groups, cookies never exported, JSON.parse OK — passed
   files: utils/postman.js, apitap.test.js
T3. Trim background.js (UPDATE_CHECKED, snapshot w/o steps/vars) → verify: node --check; UPDATE_CHECKED by id/group round-trip via mergeState test — passed
   files: background.js
T4. Rebuild panel.js + panel.html → verify: machine checks (node --check, grep no Vars/Steps/tabs) — passed; **manual DevTools smoke still pending (needs a browser)**: record → groups render, unchecked absent from export, export button disabled when nothing checked
   files: panel.js, panel.html
T5. Delete content.js; slim manifest.json → verify: greps clean; manifest JSON parses — passed
   files: content.js (deleted), manifest.json
T6. Update apitap.test.js to new API; run full suite → verify: node apitap.test.js — all green, exit 0 — passed
   files: apitap.test.js

Net: 10/10 engine/exporter tests green; full suite exit 0; all files syntax-check. Honest gap: T4's browser smoke is the one check no CLI can run — flagged for verifier/user.

## Post-ship fix 2026-09-03 — Unchecked runtime.lastError

T7. Consume runtime.lastError at all three sendMessage sites → verify: every sendMessage has a lastError-reading callback; node --check clean; suite still green — passed
   files: devtools.js, panel.js, background.js
   see memory/problems.md (closed).

T8. Fix export for MV3 (downloadJson: Blob/URL.createObjectURL → base64 data URL, unicode-safe) → verify: node --check; byte-identical base64 round-trip incl. unicode; suite green; grep shows no createObjectURL call remains — passed
   files: background.js
   see memory/problems.md (closed).

T9. Enrich Postman export to full v2.1 fidelity → verify: 11/11 suite green; official v2.1.0 JSON-schema validation (ajv draft-04) returns valid — passed
   files: utils/postman.js, apitap.test.js
   Changes: URL object now carries protocol/host/path/query(params)/hash/variable breakdown parsed from the concrete URL (raw keeps the {{baseUrl}} form); structured request.auth (bearer/basic) recognized from the Authorization header (header kept too — same value); items carry response: []; collection variable type fixed 'default'→'string' (the enum in v2.1; 'default' was schema-INVALID and the likely import blocker).

T10. Filter hygiene + transparency → verify: 14/14 suite green; probe: api.1stdibsdata.com kept, bundle.js dropped by extension, telemetry still dropped; filteredCalls capped at 200 with reasons — passed
   files: utils/filter.js, utils/correlation.js, background.js, panel.js, panel.html, apitap.test.js
   Changes: exact/subdomain-only telemetry host matching (killed host.includes over-match); purged junk entries ('1stdibs','qquared','crashtrace','gtag') and dead '/'-entries; '.js' added to ASSET_EXTENSIONS; filterReason() classifies drops; engine records dropped calls (url+reason, cap 200, in-memory); panel: clickable Filtered stat opens the dropped-list pane.

T11. Noise is now stored, not discarded — user decides via checkboxes → verify: 15/15 suite green; selectable-noise test (check noise call → appears in export as own group); noise bodies skipped; mergeState keeps noise unchecked — passed
   files: utils/correlation.js, background.js, panel.js, panel.html, apitap.test.js
   Changes: engine stores noise calls with checked:false + noiseReason (responseBody null — base64 images/media would balloon the session); burst-dedupe still drops repeats; Filtered pane + group rows both show checkboxes over the same checked state; mergeState defaults noise→unchecked, others→checked.