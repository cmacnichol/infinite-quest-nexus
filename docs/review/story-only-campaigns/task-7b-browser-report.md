# Task 7B new-UI browser handoff

Task 7A/7B are accepted after the runtime, screenshot, and independent source
reviews recorded here. Task 8 verification and live-provider quality remain
separate gates; this UI checkpoint does not complete the feature release.

## Scope and current evidence

Task 7B covers the existing new management route (`/app/campaigns/:campaignId/overview`) and Story player (`/app/story/:campaignId`) in both the native and Web Awesome renderers. The tests use the disposable runtime, PostgreSQL, worker, and synthetic text provider; they do not use frontend API mocks.

The final focused source sweep passed **192/192 tests across 12 files** at final 29-file source freeze `84fa8072a1505e651dbca4e623b6abc9c8910adae203e5330741bd11c53e57fd`. It supersedes the earlier 191-test controller checkpoint and includes the default-provider correction. The synthetic-provider helper suite passed **26/26** after adding scene/event coverage dispatch and queue-completion race coverage. The browser tests separately verify the corrected active-turn assertions, which no longer count a capped history window. TypeScript and `git diff --check` passed for the associated changes.

The native focused checkpoint passed **22 non-opening cases in 43.8 seconds** and **two empty-campaign opening cases in a separate 5.4-second run**. The subsequent fresh Native42 aggregate passed in **1.4 minutes** against owned database `26fa46c4651e4b29a39c1de6448a36ef` (runtime cell 213/session 19178, exit 0). The aggregate [summary](task-7b-native-final-summary.md) is retrospective rather than raw stdout, and no fresh served-asset hash was captured before teardown. The opening result follows the default-provider correction: a null campaign profile may use the enabled default provider under the same availability rules as the server. The native coverage includes green real-job retry coverage and the explicit two-mode Action/Story Direction submission case.

The final Web Awesome42 aggregate passed **42 cases in 1.4 minutes** against
`http://127.0.0.1:18081`, child database
`infinitequest_storyonly_3f988acb78014e8094051cdbe2fe145b`, app container
`5b9c6eb83041`, and provider container `cdf9d97668f9`. It served
`index-CBWknpmv.js` (`SHA-256
32072f4320a1510de5c703aa62daf48c474638aa48541b611c55fb4400071e05`); the
provider helper hash was
`23758ca407b77c4cee52dd562229adbc60765dc042f6dccb9522f912022a55e8`.
The command output is [task-7b-web-awesome-final-output.txt](task-7b-web-awesome-final-output.txt),
with only line endings normalized for the repository
(`SHA-256 3df89a0aa6159f80dcb37268f1d1aa7b274bb5ff47e90a3b70ded4f66b823cfb`).

The earlier Web Awesome slices remain historical diagnostics: legacy 18,
profile 2 in 3.3 seconds, composer 2 in 3.7 seconds, remaining new-UI 20 in
42.8 seconds, and the corrected `mockQuietLeaf` nine-case selection in 4.5
seconds. The final aggregate supersedes those slices as browser evidence. The
`mockQuietLeaf` selection used local Web Awesome build `index-jjhwd0Ms.js`
(`SHA-256 821a9c1af1cdf088ae4b9369e55a8f80d794385e3e1c12cc56ce6038b76ccd5b`)
and replaces the earlier wrong-local-native-distribution selection.

Both fresh42 runs have passed. Native42 predates the Web-Awesome-only CSS and
geometry amendment; Web Awesome42 includes that final static asset. The
captures below are rendered evidence for their named routes, renderers, and
viewports.

A subsequent repository check found that the test's direct console output
violated the test logging boundary. The profile metrics now use Playwright's
JSON attachment API; its assertions and screenshot flow are unchanged.
`pnpm check:repository` passed after that correction. The saved aggregate
output above precedes this diagnostic-only test change.

## Surface coverage

| Surface | Required behavior covered in source/tests | Browser result | Screenshots | Remaining gate |
| --- | --- | --- | --- | --- |
| New management overview | Existing Action/Story Direction selector has exactly two options; Story Direction saves, reloads, and is captured before switching back to Action. | Included in fresh Native42 and Web Awesome42. | [native desktop](screenshots/new-ui/management-native-desktop.png), [native mobile](screenshots/new-ui/management-native-mobile.png), [Web Awesome desktop](screenshots/new-ui/management-web-awesome-desktop.png), [Web Awesome mobile](screenshots/new-ui/management-web-awesome-mobile.png) — `/app/campaigns/:campaignId/overview`. | Accepted after runtime, screenshot, and independent source review. |
| New profile, native | Profile exposes two choices, persists Story Direction through a real successful profile PATCH and reload; automatic choice submission is separate. | Included in fresh Native42; no profile-status label is assumed for native success. | [desktop](screenshots/new-ui/profile-native-desktop.png), [mobile](screenshots/new-ui/profile-native-mobile.png) — `/app/story/:campaignId` profile dialog, native renderer. | Accepted after runtime, screenshot, and independent source review. |
| New profile, Web Awesome | Uses the real `wa-select` option interaction and real checkbox click, each guarded by the profile PATCH response. Auto is absent; the existing Actions only, Action, and Story Direction choices remain. | Included in fresh Web Awesome42. | [desktop](screenshots/new-ui/profile-visible-web-awesome-desktop.png), [mobile](screenshots/new-ui/profile-visible-web-awesome-mobile.png) — `/app/story/:campaignId` profile dialog, Web Awesome renderer; mobile visibly shows saved Story Direction. | Accepted after runtime, screenshot, and independent source review. |
| New Story player, native | Story Direction has no classifier/Auto controls and persists scene turns for typed input, generated choices, multiselect/Enter, history, stale-overview conflict, and replacement. The same campaign is loaded in the new player after legacy saves Story Direction before the new editor switches it to Action. | Included in fresh Native42, including empty opening. | [desktop](screenshots/new-ui/player-native-desktop.png), [mobile](screenshots/new-ui/player-native-mobile.png) — Story Direction player; [opening desktop](screenshots/new-ui/empty-opening-native-desktop.png), [opening mobile](screenshots/new-ui/empty-opening-native-mobile.png) — empty campaign opening, native renderer. | Accepted after runtime, screenshot, and independent source review. |
| New Story player, Web Awesome | Same two-option composer policy and Story Direction rendering path are present; both profile and composer interactions are covered by the shared new-UI E2E file. | Included in fresh Web Awesome42, including empty opening. | [desktop](screenshots/new-ui/player-web-awesome-desktop.png), [mobile](screenshots/new-ui/player-web-awesome-mobile.png) — Story Direction player; [opening desktop](screenshots/new-ui/empty-opening-web-awesome-desktop.png), [opening mobile](screenshots/new-ui/empty-opening-web-awesome-mobile.png) — empty campaign opening, Web Awesome renderer. Controls are readable and usable in the verified captures. | Accepted after runtime, screenshot, and independent source review. |
| Flexible Action → Story Direction | The new E2E case `new flexible controls submit explicit Action then Story Direction without a classifier` submits and persists both explicit modes under `flexible_action`. | Included in fresh Native42 and Web Awesome42, with no classifier traffic. | Player captures above show both renderers; this focused mode case has no separate capture. | Accepted after runtime, screenshot, and independent source review. |

## Cross-interface and state-preservation evidence

The new suite includes the same campaign identifier in both surfaces: legacy management saves Story Direction; the new player then renders the Story Direction composer; the new overview reads that saved value and changes it to Action; legacy Story confirms Action. The fresh aggregates include this path. The stale-overview case makes Story Direction authoritative, accepts a real concurrent scene turn in a second new player, receives a 409 on the stale save, and retains the unsaved Action style and title. The controller accepted the aggregate results after a separate reviewer accepted the E2E source.

Same-owner composer preservation is deliberately a model/unit boundary, not an unsupported live cross-tab claim. `tests/unit/web-next-story-model.test.ts` verifies an unchanged campaign and accepted-turn owner preserves the custom draft, selected choices, and length override as the style synchronizes Action → Story Direction → Action. The mounted player has no external campaign-settings refresh channel; a browser test must not fabricate one or use page reload as preservation evidence.

## Cleanup inventory

| Active new-UI cleanup | Evidence | Compatibility retained deliberately |
| --- | --- | --- |
| Auto option removed from management and profile choices | Overview and native profile tests require their two existing supported options; Web Awesome preferences retain their three supported options, including Actions only. All exclude `flexible_auto`. | Historical `flexible_auto` decoding remains in shared compatibility/domain paths for stored records; it is not an active new-UI choice. |
| Automatic turn-type/classifier UI removed from Story Direction | Story Direction tests assert no intent confirmation, Auto control, or classifier request. Root's final active-client search found zero `quiet-leaf-intent-confirmation`, `story-intent-confirmation`, `/turn-input`, or `classify` matches in served legacy/new-UI CSS, TypeScript, JavaScript, and HTML. | Historical accepted-turn provenance stays readable; unrelated artwork/import uses of generic `auto` remain. |
| Automatic choice submission remains separate | Native and Web Awesome profile helpers mutate the real checkbox only when needed and wait for the profile PATCH. | This preference continues to control choice submission; it is not a turn-mode selector. |
| Explicit Action/Story Direction controls remain for `flexible_action` | Fresh Native42 and Web Awesome42 verify each requested/persisted mode without classifier traffic. | Action-only campaigns remain locked to Action. |

## Runtime inventory and pending work

- The disposable runtime is owned and delivered by the runtime worker through application, provider-static, and source overlays. Its base PostgreSQL target and the main checkout remain untouched.
- Native and Web Awesome screenshot files are under `docs/review/story-only-campaigns/screenshots/new-ui/`. Root verified the Web Awesome desktop/mobile opening controls are readable and the mobile visible-profile capture shows saved Story Direction.
- The synthetic provider has focused 26/26 unit evidence for narration, scene/event coverage JSON, system-only prompt discrimination, queued overrides, malformed requests, overlapping requests, and enqueue-during-flight behavior.
- The final native overlay includes the default-provider correction; the browser suite uses corrected active-turn assertions. Its fresh Native42 aggregate passed, but its served-asset hash was not retained before teardown. Web Awesome42 ran later against the final Web-Awesome-only CSS/geometry asset recorded above.
- The Web Awesome CSS cascade correction is independently accepted in [task-7b-wa-css-review.md](task-7b-wa-css-review.md). The earlier mobile layout red was repaired, then confirmed in the final Web Awesome42 and reviewed screenshots.
- The translucent surface visible in Web Awesome is a pre-existing baseline: unchanged `theme/tokens.css` sets `--surface-paper: rgba(248,250,251,0.84)` and unchanged `ui/dialog.css` uses it. The final source comparison against `f687` found no change here. It is a cosmetic limitation, not a Story setting failure, and does not justify expanding this Task 7B scope.
- These checks use the synthetic provider and real application worker/API paths. They do not establish live-provider quality.

Task 7B browser execution evidence is complete: fresh Native42, fresh Web Awesome42, Web Awesome `mockQuietLeaf` 9/9, focused source 192/192, independent CSS/E2E reviews, and rendered screenshot review. The controller accepted Task 7A/7B after combining the independent source reviews with the runtime and screenshot evidence. A verified teardown removed the Web Awesome containers, networks, child database, and runtime record; the base 15439 runtime remains up. Live-provider quality and Task 8 verification remain separate gates that this report does not claim.
