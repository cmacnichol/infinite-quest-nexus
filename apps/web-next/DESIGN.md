---
name: "Infinite Quest Nexus"
description: "A constructed atlas interface for durable story worlds and campaigns."
colors:
  ink: "#101418"
  muted: "#46515c"
  paper: "#f8fafb"
  canvas: "#dfe7ee"
  atmosphere: "#bdcbea"
  grid: "#b8c5d0"
  grid-strong: "#8798a8"
  indigo: "#2346a8"
  indigo-dark: "#17327f"
  indigo-soft: "#c8d5f2"
  inverse-text: "#f5f7fb"
typography:
  display:
    fontFamily: "Literata, Georgia, serif"
    fontSize: "clamp(2.8rem, 7vw, 4.7rem)"
    fontWeight: 600
    lineHeight: 0.95
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Literata, Georgia, serif"
    fontSize: "clamp(1.6rem, 3vw, 2.6rem)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  title:
    fontFamily: "Literata, Georgia, serif"
    fontSize: "clamp(1.15rem, 1.4vw, 1.5rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geologica, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Chakra Petch, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
rounded:
  square: "0"
spacing:
  cell: "clamp(20px, 2.05vw, 32px)"
  edge: "clamp(20px, 4vw, 64px)"
components:
  button-primary:
    backgroundColor: "{colors.indigo}"
    textColor: "{colors.inverse-text}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "12px 18px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-dark}"
    textColor: "{colors.inverse-text}"
  search-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    height: "52px"
  navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 20px"
  theme-toggle:
    backgroundColor: "transparent"
    textColor: "{colors.indigo}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    size: "48px"
  indexed-entry:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "{spacing.cell}"
  coordinate-chip:
    backgroundColor: "{colors.indigo}"
    textColor: "{colors.inverse-text}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "7px 10px"
---

# Design System: Infinite Quest Nexus

## Overview

**Creative North Star: "Constructed Atlas Grid"**

Infinite Quest Nexus should feel like an atlas being actively indexed: precise, durable, and visibly assembled from paper, ink, editorial indigo marks, and measured cells. The system makes story records feel authored and persistent without imitating a fantasy manuscript; its confidence comes from modernist construction, disciplined information labels, and artwork given room to remain the richest material.

The interface is flat, operational, and intentionally square. Grid lines expose the underlying structure instead of hiding it, while a restrained diagonal slash, clipped corner, or indigo state creates recognition without turning every surface into decoration. Responsive changes preserve complete cells and complete content units rather than squeezing desktop fragments into narrow columns.

**Key Characteristics:**
- Paper-white fields, near-black ink, cool construction rules, and sparing editorial indigo signals.
- Visible modular cells and square divisions that explain the layout.
- Literata for a restrained literary display voice that connects the interface to reading and writing.
- Geologica for readable prose and Chakra Petch for operational hierarchy.
- Flat tonal depth, clipped cover geometry, and one focused search shadow.
- Whole-cell responsive recomposition with purposeful, reduced-motion-safe reveals.

## Colors

The palette is a cool technical paper system in light mode and a deep blue-black atlas in dark mode. Semantic tokens, rather than page-specific aliases or literal theme colors, connect every surface, text role, rule, accent, focus treatment, and artwork fallback to the active theme.

### Primary
- **Editorial Indigo (`#2346a8`):** Use for active navigation rules, focus treatments, concise actions, coordinates, authored display accents, and the recurring slash in light mode.
- **Deep Editorial Indigo (`#17327f`):** Use when the light-theme accent needs stronger text contrast or a pressed and hover state.
- **Luminous Indigo (`#8eabff`):** The dark-theme accent; use the shared `--accent` role rather than selecting it directly.

### Neutral
- **Atlas Ink:** Primary copy, structural outlines, dark brand bars, and the inverse footer field.
- **Operational Gray:** Secondary copy and lower-emphasis information.
- **Paper White:** Default component and reading surface.
- **Cool Canvas:** The blue-gray page field beneath the translucent gridded paper layer.
- **Atmosphere Plane:** A cool indigo geometric plane that gives the upper canvas directional depth without becoming decorative chrome.
- **Construction Grid:** Quiet cell lines and internal dividers.
- **Strong Construction Grid:** Major section rules and content boundaries.
- **Inverse Text:** Text and marks placed directly on indigo or the inverse surface.

### Semantic Theme Palettes

Light mode uses `#dfe7ee` page, translucent `#f8fafb` paper and entry surfaces, `#101418` primary text, `#46515c` secondary text, `#b8c5d0` / `#8798a8` rules, and the deep `#2346a8` / `#17327f` editorial indigo pair. Dark mode uses `#111821` page, translucent `#111821` paper and `#18212c` entries, `#edf2f7` primary text, `#b7c2cd` secondary text, `#39495a` / `#5b6c7e` rules, and `#8eabff` / `#b5c7ff` accents.

The shared contract is `--surface-page`, `--surface-paper`, `--surface-entry`, `--surface-entry-hover`, `--surface-muted`, `--surface-inverse`, `--surface-atmosphere`, `--text-primary`, `--text-secondary`, `--text-inverse`, `--rule`, `--rule-strong`, `--accent`, `--accent-hover`, `--accent-soft`, `--focus-shadow`, and `--artwork-fallback`.

### Named Rules

**The Indigo Signal Rule.** Editorial indigo is a state and orientation color, not a general surface fill; preserve its authority by using it sparingly.

**The Semantic Theme Rule.** Future pages and reusable components must consume semantic tokens, never World Library selectors, obsolete visual-role aliases, or literal light/dark theme colors.

**The Artwork Priority Rule.** Full-color user-provided world artwork may exceed the restrained interface palette, but surrounding UI must remain quiet enough for the artwork to lead. Theme changes must not recolor, replace, bundle, or otherwise alter that artwork.

## Typography

**Display Font:** Literata (with Georgia and serif fallbacks)
**Body Font:** Geologica (with sans-serif fallback)
**Label Font:** Chakra Petch (with sans-serif fallback)

**Character:** Literata brings the authority and warmth of long-form reading to world names and identity headings without imitating an antique manuscript. Geologica keeps narrative and explanatory copy contemporary and calm. Chakra Petch gives navigation, labels, counts, and actions an engineered operational voice.

### Hierarchy
- **Display** (600, fluid 2.8rem–4.7rem, 0.95): Use Literata for restrained identity-scale headings; keep them compact enough that the library content enters the first viewport.
- **Headline** (600, fluid 1.6rem–2.6rem, 1): Use Literata for strong state and message headings.
- **Title** (600, fluid 1.15rem–1.5rem, 1.08): Use Literata for named worlds and content entries; keep the setting compact and slightly tightened.
- **Body** (400, 1rem, 1.55): Use Geologica for descriptions and guidance, generally constrained to readable line lengths of about 55–65 characters.
- **Label** (600, 0.78rem, 0.08em, uppercase): Use Chakra Petch for operational labels, coordinates, navigation, result counts, and actions.

### Named Rules

**The Literary Display Rule.** Literata names worlds and major spaces; keep it measured, never oversized or ornamental.

**The Three-Voice Rule.** Literata names, Geologica explains, and Chakra Petch orients and operates.

## Layout

Use a visible modular cell as the spatial basis. The incumbent fluid cell ranges from 20px to 32px, while page edges range from 20px to 64px; major heights, gaps, and padding should resolve to whole or simple fractional cell measures. Strong horizontal and vertical rules should reveal grouping directly rather than relying on floating containers.

Responsive behavior is recomposition, not proportional miniaturization. Rearrange complete content units at established surface breakpoints, preserve usable touch targets, and let dense desktop arrangements become compact side-by-side rows where that keeps scanning efficient. Keep route-specific column counts, hero proportions, and content order in the applicable surface brief rather than treating one screen as global law.

### Named Rules

**The Whole-Cell Rule.** At every viewport, move and resize complete cells or content units; never leave controls, labels, or artwork as squeezed remnants of a desktop composition.

**The Visible Construction Rule.** Spacing and one-pixel rules should make the organizing grid legible without overpowering content.

## Elevation & Depth

The system is flat by default. Paper, canvas, ink fields, rules, artwork, and subtle tonal changes establish hierarchy; cards do not float and there is no ambient shadow stack. The one incumbent lifted treatment is the search field's accent-tinted focus shadow, used to concentrate attention on active text entry.

### Shadow Vocabulary
- **Search Focus** (`0 8px 24px var(--focus-shadow)`): Apply only while the primary search or similarly important query field contains keyboard focus.
- **Inset Focus** (`inset 0 0 0 3px var(--accent)`): Keep a complete clickable cell visibly bounded for keyboard users without changing layout.

### Named Rules

**The Flat-by-Default Rule.** Do not use shadows to manufacture card hierarchy; use construction rules, tonal fields, and explicit focus state instead.

## Shapes

Corners are square. Structure comes from one-pixel rules with square line caps and mitered joins, not soft radii. Content covers may clip the upper-right corner by 22px on larger layouts and 14px on compact layouts; this cut, together with the recurring diagonal slash and northeast arrow, is the system's controlled geometric exception.

### Named Rules

**The Square Rule.** Buttons, fields, navigation, tags, messages, and content containers remain unrounded.

**The One Cut Rule.** When a silhouette needs distinction, clip one purposeful corner or add one diagonal mark; do not scatter ornamental angles across every edge.

## Components

Components are precise, tactile through state rather than simulated material, and aligned to the same cell-and-rule construction.

### Buttons
- **Shape:** Square with a one-pixel border and no radius.
- **Primary:** The semantic accent with inverse uppercase Chakra Petch text and compact rectangular padding.
- **Hover / Focus:** Shift to `--accent-hover`; retain a clear `:focus-visible` outline rather than relying on color alone.
- **Secondary / Link actions:** Keep the surface transparent, use `--accent-hover` text, and pair directional actions with the square northeast arrow.

### Chips
- **Style:** Coordinates are compact accent rectangles with inverse uppercase operational text.
- **State:** Treat them as index metadata, not rounded interactive pills.

### Cards / Containers
- **Corner Style:** Square outer cell with an optional single clipped corner on media.
- **Background:** Use `--surface-entry` at rest; `--surface-entry-hover` marks hover and focus.
- **Shadow Strategy:** Flat at rest; use the inset semantic accent focus treatment for a whole clickable cell.
- **Border:** One-pixel Strong Construction Grid between entries, with ink separating cover media from copy where needed.
- **Internal Padding:** Dense index entries use roughly two-thirds of the fluid cell token; compact surfaces may use a tighter fixed inset.

### Inputs / Fields
- **Style:** Paper White, one-pixel ink border, square corners, Geologica input copy, and a semantic accent functional icon.
- **Focus:** Change the border to `--accent` and apply the Search Focus shadow to the enclosing control.
- **Placeholder / Hint:** Keep placeholder text clearly legible; keyboard hints use a small cool-gray square keycap.

### Navigation
- Use compact uppercase operational labels. Mark the current or focused destination with a three-pixel accent rule that grows from the left; directional links may animate only their arrow. On compact screens, keep the navigation as a single horizontally available row rather than collapsing product destinations into an unlabeled icon menu.

### Theme Toggle
- **Structure:** A reusable square button with a 48px column and at least a 44px target, aligned to the header construction grid.
- **Color:** Consume `--accent`, `--accent-hover`, `--accent-soft`, and `--rule-strong`; do not define page-specific theme colors.
- **State:** Show the sun icon in light mode and moon icon in dark mode. Keep the inset three-pixel focus outline visible in both themes.
- **Responsive use:** Keep the toggle in the top header row while the four product destinations recompose into the second row without clipping.

### Literary Title
- Use Literata for major spaces and world names, with compact scale, close leading, and restrained tracking. Let the visible construction grid provide the technical counterpoint rather than forcing the title itself into grid geometry.

### Indexed Content Entry
- Present artwork and text as one complete interactive cell. Keep imagery visually richer than chrome, provide a no-image grid fallback, and use a clipped cover corner, coordinate marker, concise metadata rule, and northeast action arrow as recurring wayfinding details. Exact entry composition remains surface-specific.

### Motion
- Use short state transitions for rules, color, arrows, and focus. Filtering may use the View Transitions API to reveal the newly arranged group as one unit, but only when supported and when reduced motion is not requested. Under `prefers-reduced-motion: reduce`, collapse animations and transitions to effectively immediate feedback.

## Do's and Don'ts

### Do:
- **Do** build hierarchy with semantic surfaces, text roles, editorial indigo signals, visible rules, and complete modular cells.
- **Do** use Literata at a restrained scale for major spaces, world names, and literary identity moments.
- **Do** keep Geologica for explanatory prose and Chakra Petch for operational labels and actions.
- **Do** preserve square controls, one-pixel construction rules, clipped media corners, and clear keyboard focus.
- **Do** recompose complete content units for narrow screens and honor reduced-motion preferences.
- **Do** let world artwork remain richer than the surrounding interface palette.

### Don't:
- **Don't** introduce rounded-card dashboard styling, pill controls, or soft floating panels.
- **Don't** spread the accent across large passive surfaces or use it as decoration without state or wayfinding value.
- **Don't** add ambient card shadows; reserve the focused shadow for active search or an equivalent primary query field.
- **Don't** make literary display type oversized, ornamental, or faux-antique; it should support reading and creative writing without becoming costume.
- **Don't** shrink a multi-column composition until its controls and copy become cramped; switch the whole-cell arrangement instead.
- **Don't** elevate World Library-specific column counts, hero placement, or entry order into global design law.
