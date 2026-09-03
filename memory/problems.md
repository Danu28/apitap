# Problems

## 2026-09-03 — Unchecked runtime.lastError: message port closed before response
- Class: Meaningful-quality (console noise + masked errors; export-path false-negative possible)
- Evidence: `Unchecked runtime.lastError: The message port closed before a response was received` (Context: Unknown, empty stack — a terminated-context log). Root cause: MV3 `sendMessage` errors are unhandled at all three send sites because no callback reads `chrome.runtime.lastError`:
  1. `devtools.js:57` — `sendMessage({type:'API_CALL',...})` with NO callback; the try/catch only covers sync throws. Fires when the SW is mid-termination (SW sleeps ~30s idle) — the loudest source, can repeat during recording.
  2. `panel.js:32` — callback ignores lastError; when the SW dies mid-await (e.g., EXPORT handler awaiting the saveAs dialog, GET_SESSION awaiting restore) or DevTools closes mid-flight, `res` is undefined → resolves `{}` as success, masking real errors in toasts.
  3. `background.js:26` — broadcastUpdate callback `() => {}` ignores lastError; panel closed → no receiver.
- Why not blocking: MV3 message delivery wakes the SW (queued), so captures aren't demonstrably lost; recording works.
- Fix (4 lines, standard MV3 hygiene): consume lastError at each site — devtools: `(msg, () => void chrome.runtime.lastError)`; panel: read `void chrome.runtime.lastError` and resolve `{success:false, error:...}` when `res === undefined`; background: same `() => void chrome.runtime.lastError`. Optional follow-up: EXPORT handler can respond optimistically after queuing the download so the panel toast doesn't depend on the saveAs dialog outliving the SW.
- Status: FIXED 2026-09-03 — lastError consumed at all three sites: devtools.js:59 (callback `() => void chrome.runtime.lastError`), panel.js:32 (reads lastError; undefined res now resolves `{success:false, error:...}` instead of fake `{}`), background.js:27 (same consume pattern). Syntax + suite re-verified green.

## 2026-09-03 — Export broken: URL.createObjectURL is not a function
- Class: Blocking (export did not function at all in MV3)
- Evidence: user report `Uncaught (in promise) TypeError: URL.createObjectURL is not a function`, background.js:75 — `URL.createObjectURL` is a document-context API, absent in extension service workers (Chromium limitation). Reproduced logically: code at the named line is exactly that call.
- Fix: background.js downloadJson now emits a `data:application/json;base64,` URL (TextEncoder byte-encoding + btoa for unicode safety). Proven: byte-identical round-trip incl. em-dash/unicode/emoji; 33% inflation; suite green. Comment left at the site explaining the constraint.
- Residual (pre-existing, optional): SW death while saveAs dialog open can still leave the toast reporting failure — cosmetic, not export-breaking.