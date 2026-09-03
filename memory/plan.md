# ApiTap v2 — Plan

## Restatement (user intent)
> A cleaner version of ApiTap: Record → capture all requests → filter (group requests) → user decides what to export with checkboxes → export.

Defaults adopted verbatim: cut token chaining, credential swap, status assertions, environment + session-JSON export; checkbox granularity is group-level AND per-request (expanded); custom rename input is cut (names auto-generate as "METHOD lastPathSegment").

## Acceptance Criteria
- AC1. Recording start/stop works; captured calls appear grouped by method+host+path with per-group counts; assets/telemetry excluded. → smoke + engine unit test
- AC2. Unchecking a group (or a single request inside it) excludes it from export; re-checking restores it. → engine unit test
- AC3. Export writes a valid Postman v2.1 collection, folders per group, only checked requests, noise headers dropped. → apitap.test.js build-collection assert + JSON.parse
- AC4. Session + checkbox state survive DevTools close/reopen and service-worker restarts. → mergeState round-trip test
- AC5. content.js, content_scripts, host_permissions, activeTab, scripting are gone. → grep + manifest parse + unpacked-load smoke
- AC6. apitap.test.js green on the slimmer engine. → node apitap.test.js

## Quality Contract (Code | M-lane)
1. Every feature not named in non-goals still works: record/stop/persist/noise-filter/dedupe/export download.
2. No dead code left behind — steps, variables, auth, reviewName, tabs — provable by grep.
3. Engine + exporter stay pure dual-exported modules; apitap.test.js covers grouping, checked-filtering, export validity.
4. All captured strings rendered with escapeHtml in the panel (as today).
5. Malformed/unparseable URLs never throw — they land in an "unparseable" bucket.

## Design (builder facts — build from here, not the conversation)
- **Files kept & untouched:** `utils/filter.js` (noise filter), `devtools.js` (network capture; `startedDateTime`-based ts + 200KB truncation already in place), `manifest` shell shape.
- **Engine stays at `utils/correlation.js`** (keep filename — `importScripts` line in background.js unchanged). Slim it: delete steps/tabStepIndex/stepLabel, variable machinery (TOKEN_KEYS, extractTokens, extractProduced, findConsumed, looksLikeAuth, sanitizeVarName), and `included`/`reviewName`. Keep: addCall ingestion, fingerprint burst-dedupe, noise-filter call, truncateBody, serialize/mergeState, getStats.
- **Grouping is derived, not stored:** `groupKey(call) = METHOD + '|' + host + '|' + pathname` (drop query + hash). Single Map pass over `calls` at render and at export. Non-URL → `groupKey === 'unparseable'`, never a throw.
- **Checkbox state lives in the persisted call record** (`call.checked`, default true — NOT in the panel; the panel dies when DevTools closes). `mergeState` legacy map: `saved.checked === undefined && saved.included === false → checked = false` (one line, old sessions keep their exclusions).
- **UPDATE_CHECKED message:** accepts `{id}` (single call) or `{groupKey}` (sets every call in the group); background mutates, persists, broadcasts. Replaces UPDATE_CALL_REVIEW; UI_ACTION handler and content.js wiring deleted.
- **Export:** `buildCollection(calls)` filters `checked !== false`, groups by groupKey, folder name `METHOD /path`, item name `METHOD lastPathSegment`, collection variable `{{baseUrl}}` = most-common origin. buildEnvironment, detectCredentialBody, applyCredentialSwapToBody, authTestLines, assertionTestLines, substituteValues (and its consumers) deleted. Header noise-drop (pickHeaders/DROP_HEADERS) KEPT.
- **Panel = one pane, no tabs:** header (status pill + Record/Stop/Clear), stats bar (Calls, Groups, Filtered, Deduped — Vars/Steps gone), grouped checklist, "Export selected" button (runs EXPORT_POSTMAN). Group row: checkbox (indeterminate if mixed) · method badge · path · count. Row click expands → request rows: checkbox · status · truncated url/time. All strings escapeHtml'd.
- **Debounce:** panel `fetchSession()` on SESSION_UPDATED throttled 200ms (single setTimeout guard) — broadcast fires per call, this caps render churn.
- **Manifest:** drop content_scripts, host_permissions, activeTab, scripting. Permissions left: download, storage, unlimitedStorage. devtools_page + background stay. DevTools capture needs no host permission.
- **Delete:** `content.js` (only references: manifest content_scripts + background UI_ACTION case).

## Risk Notes
- Filesystem writes: export download writes captured request/response data to disk (saveAs, local). Injection confined by JSON.stringify; no eval of captured data anywhere.
- Storage: full request/response bodies (sensitive) persisted in chrome.storage.local with unlimitedStorage. Local-only; extension makes no network calls itself.
- Untrusted parsed input: URLs/bodies from arbitrary inspected pages feed regex + JSON.parse — both already try/catch-guarded; unparseable bucket covers URL failures.

## Tasks (current)
| # | Task | Verify | Footprint | Est |
|---|------|--------|-----------|-----|
| T1 | Slim utils/correlation.js: delete steps/variables machinery; add groupKey() + stats.groups; included→checked with legacy map | apitap.test.js grouping + checked asserts pass | boundary | M |
| T2 | Trim utils/postman.js: delete env/cred/assertion modules; buildCollection filters checked, folders per group | test: collection has only checked calls; JSON.parse OK | boundary | M |
| T3 | Trim background.js: delete handleUIAction + UPDATE_CALL_REVIEW; add UPDATE_CHECKED (id or groupKey); drop vars from snapshot | node --check; UPDATE_CHECKED by id and by group round-trip via mergeState | none | S |
| T4 | Rebuild panel.js + panel.html: single-pane checklist, group/request checkboxes, export-selected button, 200ms fetchSession debounce | manual smoke: groups+counts render; unchecked absent from export; grep shows no Vars/Steps/tabs | hot-path | M |
| T5 | Delete content.js; slim manifest.json (drop content_scripts/host_permissions/activeTab/scripting) | grep clean; manifest parses; unpacked load smoke | none | S |
| T6 | Update apitap.test.js to new API; run full suite | node apitap.test.js — all green, exit 0 | none | S |

Loop budget: 2. Revisions appended as dated deltas below; latest delta's Tasks (current) is what the builder builds.

## Reflection
2026-09-03 — Pass (2 quality notes): all 6 ACs met in code + engine/exporter tests (AC2/AC3/AC6 fully proven; AC1/AC4/AC5 proven via tests + greps). AC1's live record→render flow awaits the 30-second browser smoke (unrunnable on CLI) — see problems.md none; open item in verdict only.

## Revision 2026-09-03 — Gate 2 reviewer cuts (user approves this delta only)

Changes vs original plan:
1. DELETED: legacy `included → checked` migration map in mergeState (no v1 compatibility; old sessions' exclusions revert to checked once, one-click re-exclude).
2. DELETED: tabId from the stored call schema + panel/background refs (no consumer after steps die; devtools.js untouched — its message still carries extra fields the engine ignores).
3. SIMPLIFIED (explicit): pickHeaders cookie special-case dies with chaining — ALL cookies drop as transport noise (recorded cookie = stale session state, never test data).
4. ADDED (T4): Export button disabled when session is empty or zero calls checked — no empty-collection success export.

### Tasks (current)
| # | Task | Verify | Footprint | Est |
|---|------|--------|-----------|-----|
| T1 | Slim utils/correlation.js: delete steps/tabStepIndex/stepLabel + variables machinery (TOKEN_KEYS/extractTokens/extractProduced/findConsumed/looksLikeAuth); add groupKey() + stats.groups; `checked` field default true (no legacy map); stop persisting tabId | apitap.test.js grouping + checked asserts pass | boundary | M |
| T2 | Trim utils/postman.js: delete buildEnvironment/detectCredentialBody/applyCredentialSwapToBody/authTestLines/assertionTestLines/substituteValues; pickHeaders drops cookie special-case; buildCollection filters checked, folders per group | test: collection has only checked calls, folders = groups, cookies never exported; JSON.parse OK | boundary | M |
| T3 | Trim background.js: delete handleUIAction + UPDATE_CALL_REVIEW; add UPDATE_CHECKED (id or groupKey); drop vars/steps from snapshot | node --check; UPDATE_CHECKED by id and by group round-trip via mergeState | none | S |
| T4 | Rebuild panel.js + panel.html: single-pane checklist, group/request checkboxes, export-selected button (disabled when nothing checked), 200ms fetchSession debounce | manual smoke: groups+counts render; unchecked absent from export; grep shows no Vars/Steps/tabs | hot-path | M |
| T5 | Delete content.js; slim manifest.json (drop content_scripts/host_permissions/activeTab/scripting; keep devtools_page, download, storage, unlimitedStorage) | grep clean; manifest parses; unpacked load smoke | none | S |
| T6 | Update apitap.test.js to new API; run full suite | node apitap.test.js — all green, exit 0 | none | S |