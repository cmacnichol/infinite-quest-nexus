# Characters Revamp Review Fixes

**Source:** Post-implementation review of the uncommitted `codex/characters-revamp` worktree against the [revamp plan](2026-11-06-characters-revamp.md), [interface plan](2026-11-06-characters-interface.md) and [automation plan](2026-11-06-characters-automation.md).

**Goal:** Close the gaps the review found without widening scope. Each fix is listed with what it changes and how it is checked.

## F1. Turn off lexical mention tracking unless auto-match is enabled (high)

Today `recordAcceptedTurnCastMentions` runs on every accepted turn and correction, whatever the cast flags say. The automation plan requires: "Disabling it prevents new relaxed admissions and lexical mention work."

- `AcceptedGenerationCommit` gets `castLexicalMentions?: boolean`. `commitAcceptedTurn` runs the hook only when it is true.
- Generation collaborators expose `castLexicalMentionsEnabled`, set from the effective `castAutoMatchEnabled`. That setting already requires discovery and editing. The executor forwards it to the commit.
- `PostgresTurnCorrectionCollaborators` gets `castLexicalMentionsEnabled?: boolean`, which the API sets from runtime config.
- Default is off everywhere. Tests that exercise mentions opt in explicitly.

**Check:** extend the existing generation integration fixture. With the flag off, an accepted turn writes no `lexical:%` events; with it on, current behaviour is unchanged.

## F2. Commit the work (high, process)

- Commit the reviewed implementation as one baseline commit on `codex/characters-revamp`. Splitting it into per-task commits after the fact is not reliable, so the commit message names the plan tasks it covers.
- Commit these fixes as a separate commit so they can be reviewed on their own.

## F3. Cut the write load from the workspace-change counter (medium)

Migration `0120` uses row-level triggers on hot tables. Every job lease or checkpoint update bumps the counter, which makes open panels reload the full roster every 5 seconds.

- Migration `0120` has never been applied to a shared or deployed database, so rewrite it in place:
  - Use statement-level triggers with transition tables on candidates, characters, events, observations and turns. Each statement then bumps each affected campaign once.
  - Discovery jobs get a row-level trigger guarded by `WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.diagnostic_code IS DISTINCT FROM NEW.diagnostic_code)` for updates, plus insert and delete. Lease, heartbeat and checkpoint writes no longer count as workspace changes.
  - Add a Down section.

**Check:** existing migration and status integration suites. Add one assertion that a checkpoint update leaves `workspace_revision` unchanged.

## F4. Close the replacement-client roster gaps from U3 (medium)

- Each roster row shows Main character / Added by you / Discovered, Pinned and Ignored badges, and that character's review count. This matches the legacy client.
- Both clients label the Recent filter "Recent · last N turns" using the server's `recentWindow`. The label falls back to 10 when an older server omits it. The session keeps `recentWindow` in its state.

**Check:** the existing panel/tools unit suites and the cast Playwright journey. No new suites.

## F5. Edit the main character inside the sheet (medium)

- The replacement workspace renders the shared `createCharacterProfileForm` in the sheet, not by closing and opening the separate dialog. It saves through the existing `/character-profile` endpoint with `expectedRevision`.
- A conflict (409) keeps the draft and shows a reconcile message. The existing dirty-draft guard covers Close, Back and roster navigation. Editing stays disabled while generation is active.
- After a save, the workspace refreshes its cached profile and tells the Story page so the page reloads its own copy.

**Check:** extend the existing cast browser journey's protagonist edit step.

## F6. Smaller deviations (low)

1. **Shared filter predicate.** Move the legacy-server filter predicate into pure `client-core/characters/workspace.ts` (`matchesCharacterFilter`, `isRecentCharacter`). The session uses it instead of inline logic. `CharacterSheet.locks` lists the field paths held by a manual correction, so automatic updates cannot replace them.
2. **Pagination restart.** When the revision changes mid-pagination, restart once immediately with fresh status, and only enter backoff if it changes again.
3. **Matcher precision.**
   - Drop a mention whose range is contained in a longer mention of the same character (name versus "Name Surname").
   - Skip sentence-initial matches of single-word names that are also common English words (Hope, Grace, Will, May, …). Missing a mention is better than recording a wrong one.
   - Extend the existing matcher table.
4. **Migrations.**
   - `0118` Down refuses when detach-review rows exist, matching the `0110` pattern, instead of deleting them.
   - Add Down sections to `0119` and `0120`.
5. **Screenshots.** Move them to `docs/review/assets/characters-revamp/` as the interface plan specifies, and update links.

**Out of scope, no change:** the omitted candidate-addressed detach adapter (the plan allowed omitting it), and the cropped native-zoom captures (the acceptance report already states this limit; re-capturing needs an interactive browser session).

## Verification

Run the affected unit suites, `pnpm check`, client-boundary check, focused PostgreSQL suites for generation/lifecycle/migrations/status when a database is available, and `git diff --check`. Record results in the acceptance report; skipped database runs are reported as skipped.
