# Web Theme System Design

## Scope

Implement a reusable light/dark theme foundation for `apps/web-next`, beginning with the World Library Overview. The work includes a compact header toggle, system-preference detection, persisted manual selection, semantic theme tokens, and automated tests. It does not add account-level preference storage or change world artwork.

## User Experience

- On first visit, the application follows `prefers-color-scheme`.
- The header presents one icon-only theme button with an authored sun or moon SVG.
- The button's accessible label names the action: `Use dark theme` or `Use light theme`.
- Activating the button immediately switches theme and stores the explicit `light` or `dark` choice.
- A stored manual choice wins over later operating-system changes.
- Without a stored choice, operating-system theme changes update the application live.
- The current bright cobalt becomes a darker editorial indigo in both themes.

## Architecture

Create `apps/web-next/src/theme.ts` as the single browser-independent theme policy module. It exposes:

- validated theme values: `light | dark`;
- stored-preference parsing;
- resolution from stored preference and system preference;
- opposite-theme selection;
- storage key and DOM application helpers;
- initialization that returns cleanup behavior for media-query listeners.

`bootstrap.ts` owns rendering the shared header button and wires it to the theme module. Future pages reuse the same module and button contract rather than reimplementing theme state.

The resolved theme is represented on `<html>` as `data-theme="light|dark"` and through `color-scheme`. A small synchronous same-origin script from `public/theme-bootstrap.js` resolves the initial theme before the application module loads, minimizing incorrect-theme flash while remaining compatible with production `script-src 'self'`. This bootstrap uses the same storage key and validation rules as the module; `index.html` contains no inline executable script.

## Token Model

Refactor visual colors into semantic CSS custom properties rather than page-specific light values:

- page and atmospheric surfaces;
- component and elevated surfaces;
- primary, secondary, and inverse text;
- normal and strong construction rules;
- accent, accent-hover, and accent-soft;
- focus shadow and artwork fallback fields.

`:root` supplies the light theme. `:root[data-theme="dark"]` overrides semantic values for a dark ink-blue canvas, lighter text, subdued construction rules, and a deep accessible indigo accent. Structural, spacing, typography, and artwork rules remain shared.

The theme toggle is a square atlas-grid control, not a pill. It uses the existing one-pixel construction border, a 44px minimum target, authored SVG geometry, visible keyboard focus, and no decorative motion.

## Error and Edge Handling

- Invalid or unavailable stored values are ignored.
- Storage read/write failures do not block rendering or toggling.
- Missing `matchMedia` falls back to light mode.
- A manual choice stops system-change synchronization for the current session.
- Both themes preserve visible focus, readable placeholder text, loading states, empty/error states, and artwork fallbacks.

## Testing

Use test-driven development for `theme.ts`:

1. Stored `light` and `dark` values resolve correctly.
2. Invalid stored values are ignored.
3. With no stored value, system dark preference resolves to dark.
4. With no stored value and no dark preference, resolution is light.
5. Toggling returns the opposite theme.
6. Applying a theme updates the document theme contract.
7. Manual selection persists when storage is available and remains functional when storage throws.

Run the web-next TypeScript check, production build, targeted unit tests, `git diff --check`, and bounded desktop/mobile visual verification in both themes.

## Non-Goals

- Server-side or user-profile preference storage.
- More than two explicit toggle states.
- Theme-dependent changes to user-generated cover artwork.
- A second page-specific theme implementation.
