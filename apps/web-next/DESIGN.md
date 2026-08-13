---
name: "Infinite Quest Nexus"
description: "A constructed atlas interface for durable story worlds and campaigns."
colors:
  ink: "#101418"
  muted: "#525c66"
  paper: "#f8fafb"
  canvas: "#dfe7ee"
  atmosphere: "#cbdcff"
  grid: "#ccd6df"
  grid-strong: "#9aa9b7"
  cobalt: "#064ef5"
  cobalt-dark: "#003bbd"
  white: "#ffffff"
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
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "12px 18px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-dark}"
    textColor: "{colors.white}"
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
  indexed-entry:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "{spacing.cell}"
  coordinate-chip:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "7px 10px"
---

# Design System: Infinite Quest Nexus

## Overview

**Creative North Star: "Constructed Atlas Grid"**

Infinite Quest Nexus should feel like an atlas being actively indexed: precise, durable, and visibly assembled from paper, ink, cobalt marks, and measured cells. The system makes story records feel authored and persistent without imitating a fantasy manuscript; its confidence comes from modernist construction, disciplined information labels, and artwork given room to remain the richest material.

The interface is flat, operational, and intentionally square. Grid lines expose the underlying structure instead of hiding it, while a restrained diagonal slash, clipped corner, or cobalt state creates recognition without turning every surface into decoration. Responsive changes preserve complete cells and complete content units rather than squeezing desktop fragments into narrow columns.

**Key Characteristics:**
- Paper-white fields, near-black ink, cool construction rules, and sparing cobalt signals.
- Visible modular cells and square divisions that explain the layout.
- Literata for a restrained literary display voice that connects the interface to reading and writing.
- Geologica for readable prose and Chakra Petch for operational hierarchy.
- Flat tonal depth, clipped cover geometry, and one focused search shadow.
- Whole-cell responsive recomposition with purposeful, reduced-motion-safe reveals.

## Colors

The palette is a cool technical paper system: an atmospheric blue-gray canvas separates the page from its paper fields, ink carries authority, pale construction rules expose the grid, and cobalt marks only identity, focus, active state, and decisive action.

### Primary
- **Signal Cobalt:** Use for active navigation rules, focus treatments, concise actions, coordinates, authored display accents, and the recurring slash.
- **Deep Cobalt:** Use when cobalt needs stronger text contrast or a pressed and hover state.

### Neutral
- **Atlas Ink:** Primary copy, structural outlines, dark brand bars, and the inverse footer field.
- **Operational Gray:** Secondary copy and lower-emphasis information.
- **Paper White:** Default component and reading surface.
- **Cool Canvas:** The blue-gray page field beneath the translucent gridded paper layer.
- **Atmosphere Plane:** A pale cobalt geometric plane that gives the upper canvas directional depth without becoming decorative chrome.
- **Construction Grid:** Quiet cell lines and internal dividers.
- **Strong Construction Grid:** Major section rules and content boundaries.
- **Pure White:** Text and marks placed directly on cobalt or ink.

### Named Rules

**The Cobalt Signal Rule.** Cobalt is a state and orientation color, not a general surface fill; preserve its authority by using it sparingly.

**The Artwork Priority Rule.** Full-color world artwork may exceed the restrained interface palette, but surrounding UI must remain quiet enough for the artwork to lead.

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

The system is flat by default. Paper, canvas, ink fields, rules, artwork, and subtle tonal changes establish hierarchy; cards do not float and there is no ambient shadow stack. The one incumbent lifted treatment is the search field's cobalt-tinted focus shadow, used to concentrate attention on active text entry.

### Shadow Vocabulary
- **Search Focus** (`0 8px 24px rgba(6, 78, 245, 0.13)`): Apply only while the primary search or similarly important query field contains keyboard focus.
- **Inset Focus** (`inset 0 0 0 3px #064ef5`): Keep a complete clickable cell visibly bounded for keyboard users without changing layout.

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
- **Primary:** Signal cobalt with pure-white uppercase Chakra Petch text and compact rectangular padding.
- **Hover / Focus:** Shift to Deep Cobalt; retain a clear `:focus-visible` outline rather than relying on color alone.
- **Secondary / Link actions:** Keep the surface transparent, use Deep Cobalt text, and pair directional actions with the square northeast arrow.

### Chips
- **Style:** Coordinates are compact cobalt rectangles with white uppercase operational text.
- **State:** Treat them as index metadata, not rounded interactive pills.

### Cards / Containers
- **Corner Style:** Square outer cell with an optional single clipped corner on media.
- **Background:** Paper White at rest; Pure White may mark hover and focus.
- **Shadow Strategy:** Flat at rest; use the inset cobalt focus treatment for a whole clickable cell.
- **Border:** One-pixel Strong Construction Grid between entries, with ink separating cover media from copy where needed.
- **Internal Padding:** Dense index entries use roughly two-thirds of the fluid cell token; compact surfaces may use a tighter fixed inset.

### Inputs / Fields
- **Style:** Paper White, one-pixel ink border, square corners, Geologica input copy, and a cobalt functional icon.
- **Focus:** Change the border to Signal Cobalt and apply the Search Focus shadow to the enclosing control.
- **Placeholder / Hint:** Keep placeholder text clearly legible; keyboard hints use a small cool-gray square keycap.

### Navigation
- Use compact uppercase operational labels. Mark the current or focused destination with a three-pixel cobalt rule that grows from the left; directional links may animate only their arrow. On compact screens, keep the navigation as a single horizontally available row rather than collapsing product destinations into an unlabeled icon menu.

### Literary Title
- Use Literata for major spaces and world names, with compact scale, close leading, and restrained tracking. Let the visible construction grid provide the technical counterpoint rather than forcing the title itself into grid geometry.

### Indexed Content Entry
- Present artwork and text as one complete interactive cell. Keep imagery visually richer than chrome, provide a no-image grid fallback, and use a clipped cover corner, coordinate marker, concise metadata rule, and northeast action arrow as recurring wayfinding details. Exact entry composition remains surface-specific.

### Motion
- Use short state transitions for rules, color, arrows, and focus. Filtering may use the View Transitions API to reveal the newly arranged group as one unit, but only when supported and when reduced motion is not requested. Under `prefers-reduced-motion: reduce`, collapse animations and transitions to effectively immediate feedback.

## Do's and Don'ts

### Do:
- **Do** build hierarchy with paper, ink, cobalt signals, visible rules, and complete modular cells.
- **Do** use Literata at a restrained scale for major spaces, world names, and literary identity moments.
- **Do** keep Geologica for explanatory prose and Chakra Petch for operational labels and actions.
- **Do** preserve square controls, one-pixel construction rules, clipped media corners, and clear keyboard focus.
- **Do** recompose complete content units for narrow screens and honor reduced-motion preferences.
- **Do** let world artwork remain richer than the surrounding interface palette.

### Don't:
- **Don't** introduce rounded-card dashboard styling, pill controls, or soft floating panels.
- **Don't** spread cobalt across large passive surfaces or use it as decoration without state or wayfinding value.
- **Don't** add ambient card shadows; reserve the focused shadow for active search or an equivalent primary query field.
- **Don't** make literary display type oversized, ornamental, or faux-antique; it should support reading and creative writing without becoming costume.
- **Don't** shrink a multi-column composition until its controls and copy become cramped; switch the whole-cell arrangement instead.
- **Don't** elevate World Library-specific column counts, hero placement, or entry order into global design law.
