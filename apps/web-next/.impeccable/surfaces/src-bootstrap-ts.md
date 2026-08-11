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
Constructed Atlas Grid: a visible modular grid paired with restrained literary display typography, cobalt focus states, and a recurring diagonal slash. World cover art remains the richest visual material. Search reorganizes results by whole grid cells without layout shifts.

## Constraints
Overview only. Editing, creation, publication, versions, archives, import/export, and campaign management remain in dedicated sections. Support keyboard and screen-reader operation, reduced motion, and responsive one/two/multi-column layouts.
