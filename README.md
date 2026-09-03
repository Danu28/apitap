# ApiTap — Postman Data Generator

Record the API calls a manual test run makes on a tab, group them by endpoint, pick what to keep, and export a runnable Postman collection.

No DevTools panel, no content scripts — capture rides on the Chrome debugger protocol attached to the active tab, so recording works even with DevTools closed.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select this folder
4. Pin the ApiTap icon for one-click access

Creating a proper CRX/Web Store build is a follow-up; for now this is a load-unpacked extension.

## Usage

1. Open the page you're about to test and click the **ApiTap** toolbar icon
2. **Record** — attaches to the active tab. Chrome shows a small "debugging this browser" bar while it runs (that's the `debugger` permission doing its job)
3. Drive the page. The popup closes while you do — recording continues in the background
4. Reopen ApiTap: requests are **grouped by endpoint** (`METHOD host/path`, query collapsed); check/uncheck anything, including calls it flagged as noise
5. **Export selected** — downloads `apitap-<host>-<date>-<time>.json` (e.g. `apitap-api-shop-com-20260903-193011.json`; Postman v2.1): one folder per endpoint group, full URL breakdown (params), structured bearer/basic auth from the captured `Authorization` header, `{{baseUrl}}` collection variable

## What you should know

- **Every request is kept, nothing is silently deleted.** Requests the filter judges as noise (static assets, analytics/telemetry) are stored *unchecked* with a reason tag — click **Filtered** in the stats bar to see them and tick any you want (e.g. `text/javascript`-served API endpoints).
- **Cookies are never exported** — a recorded cookie is stale session state that would break replay. Bearer/basic tokens from the `Authorization` header are exported (as headers *and* as the Postman Auth tab).
- **Body limits:** response bodies are truncated at 200KB; noise responses are captured without bodies.
- **Capture scope:** only requests made while recording, on the tab you started from. Opening DevTools on that tab detaches the debugger and stops recording gracefully.
- **Session persistence:** the session and your checkbox selection survive service-worker restarts and popup closes (stored in `chrome.storage.local`, `unlimitedStorage`).

## Permissions

| Permission | Why |
|---|---|
| `debugger` | CDP capture of the recorded tab (method, URL, headers, request + response bodies) |
| `downloads` | Export the Postman collection with save-as |
| `storage` + `unlimitedStorage` | Session + selection persistence across restarts |

No `host_permissions`, no content scripts, no network calls made by the extension itself.

## Development

```
node apitap.test.js    # 18 tests: noise filter, grouping, checked-state, exporter, CDP mapping
```

Pure logic lives in `utils/` (dual-exported so Node can test it):

- `filter.js` — noise classification (`filterReason`: telemetry / asset-extension / asset-content-type)
- `correlation.js` — session engine: ingest, burst-dedupe, endpoint grouping, `checked` state
- `postman.js` — Postman v2.1 export (schema-validated against the official collection schema)
- `debugcapture.js` — CDP Network event → internal call shape

The remaining glue (debugger attach/events, storage, downloads) is browser-only — smoke it by recording a login flow and importing the export into Postman.

## License

MIT (do whatever you want; used responsibly). See [LICENSE](LICENSE).