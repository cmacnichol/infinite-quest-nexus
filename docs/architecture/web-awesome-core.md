# Web Awesome Core preserves the application boundary

## Status

Accepted for the opt-in Quiet Leaf replacement Story interface; it is not a release or default-on decision.

## Context

Quiet Leaf needs a small set of accessible controls without moving the Vite application to another framework or making vendor styling, assets, or overlay behavior authoritative. The selected Core 3.12.0 dialog did not provide the required accessible name in Chromium, so overlays require an application boundary rather than a vendor-internal workaround.

## Decision

Pin `@awesome.me/webawesome` to Core 3.12.0 and load only the individual control modules used by the replacement Story interface. Application-owned semantic tokens in `apps/web-next/src/theme/tokens.css` remain authoritative; `apps/web-next/src/ui/web-awesome-theme.css` is the one adapter that maps them to Core tokens and uses documented public CSS parts only. System icons are emitted with the Vite build and resolved through the same application origin; no runtime CDN, hosted theme, external font, autoloader, whole-library import, or Pro dependency is part of this design.

Use the application-owned native `mountDialog()` wrapper for overlays. It supplies labelled native-dialog semantics, close/Escape behavior, opener restoration, and explicit disposal without patching Core internals or creating another focus trap. Control modules expose typed callbacks and each owning view retains its lifecycle and cleanup responsibility.

The existing native renderer remains the rollback path. This decision does not rewrite the framework, relax CSP, change authoritative campaign or profile APIs, or change campaign/world/user boundaries, accepted-turn immutability, generation idempotency, or independent illustration jobs. Browser display and navigation preferences remain local presentation state.

## Consequences

- Core additions must be individual imports, typed at the application boundary, and mapped through the shared adapter instead of page-local vendor overrides.
- A Core upgrade is gated by installed-type review, vendor release and license-notice review, same-origin icon validation, focused and browser compatibility evidence, bundle comparison, and a tested native rollback. Unit tests alone cannot merge an upgrade.
- The native fallback remains for at least one release after stable Core usage. Its removal is a separately approved task, never incidental cleanup.
- The current implementation is still opt-in. Any later default-on or container build-argument decision must be backed by the full release gates; it is not established by this record.
