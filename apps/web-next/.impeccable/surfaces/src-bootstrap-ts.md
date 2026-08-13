---
version: 1
slug: "src-bootstrap-ts"
primary_target: "src/bootstrap.ts"
related_targets: ["index.html","src/styles.css"]
---

## Scope and mode
World Library Overview at `src/bootstrap.ts`. Operate mode.

## Audience and job
Creative-fiction and RPG readers browse and search a populated library to recognize and open a reusable world.

## Content and task
Search is primary. Each world exposes cover art, title, a short description, and campaign count. Results come from the authoritative `/api/v1/worlds` endpoint; application source contains no sample worlds or campaigns.

## Direction
Constructed Atlas Grid: a visible modular grid paired with restrained literary display typography, semantic accent focus states, and a recurring diagonal slash. Light and dark themes preserve artwork priority, the visible grid structure, and compact browsing density; user-provided world cover art remains the richest visual material and is not recolored, retinted, or replaced by theme changes. Media hover treatment uses the theme-invariant `--artwork-overlay`, while keyboard focus remains visible around the enclosing cell. Search reorganizes results by whole grid cells without layout shifts.

## Constraints
Overview only. Editing, creation, publication, versions, archives, import/export, and campaign management remain in dedicated sections. Support keyboard and screen-reader operation, reduced motion, responsive one/two/multi-column layouts, and a 44px-minimum theme toggle that stays in the top mobile header row while all four navigation destinations remain unclipped in the second row. Consume the complete shared semantic theme contract, including `--text-on-accent` for every filled accent foreground, `--rule-grid` and `--accent-grid` for faint construction lines, and the focus/artwork roles; do not couple future surfaces to World Library selectors, obsolete aliases, literal theme colors, or selector-local color composition.
