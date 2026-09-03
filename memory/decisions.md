# Decisions

2026-… — ApiTap v2 (cleaner version, user-approved with defaults):
1. Cut export smarts: no token chaining, credential swap, status assertions, environment export, session-JSON export. Re-addable later; replay of logged-in flows then needs Postman-side auth.
2. Checkbox granularity: group-level + per-request (expanded). Group toggle sets every call in the group.
3. Custom rename input cut — exported names auto-generate as "METHOD lastPathSegment".
4. Grouping is derived at render/export (Map pass), never stored in state.
5. Checkbox state persisted in the session record (call.checked), not the panel — panel dies on DevTools close.
6. Group/folder key = METHOD + host + pathname (query+hash dropped); malformed URLs bucket to 'unparseable' without throwing.
7. Engine filename kept as utils/correlation.js to avoid importScripts churn.
8. Panel render debounced 200ms on SESSION_UPDATED (broadcast fires per captured call).