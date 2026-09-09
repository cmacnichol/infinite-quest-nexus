# Native runtime checkpoint

The disposable Native-component runtime at `http://127.0.0.1:18081` used child database `infinitequest_storyonly_6430d0c947e447f2ad8529f46b34301f`. It used only its dedicated app and synthetic-provider containers on network `iq-storyonly-bf467463a85548d6839539545a888485`; the shared base PostgreSQL service on port 15439 was retained.

The served Native web asset was `index-d2Sr_-tm.js` (SHA-256 `d91fa83ebc7cc6448531087b6052de7faea9915674fe43d4e1bd042a31dc7747`). The overlaid synthetic-provider helper was SHA-256 `23758ca407b77c4cee52dd562229adbc60765dc042f6dccb9522f912022a55e8`.

Browser evidence on this mutable runtime:

- Legacy suite: 18 passed (35.2 s).
- New UI non-opening suite: 22 passed (43.8 s).
- New UI empty-opening focused cases: 2 passed (5.4 s), with new accepted turns on the separate desktop and mobile fixtures.
- Explicit Action then Story Direction focused cases: 2 passed (8.6 s).
- Synthetic-provider harness unit test: 26 passed (1.68 s).

The retained recoverable Scene job `47c872e7-2f4a-45dc-8db7-2707f75897a3` was retried through the browser UI after the provider helper update. It completed on attempt 3 and accepted turn 54 as `69fc8087-bc42-4a9e-9c21-0654275255c6`; it was not discarded. This checkpoint used mutable app/provider overlays, so the subsequent fresh Web Awesome runtime remains the image-level aggregate gate.
