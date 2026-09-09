# Task 7A legacy browser verification

The fresh native disposable runtime passed all 18 legacy browser tests on 2026-09-09 (35.2 seconds, Playwright session 80827, exit 0). This verifies the served Nexus and Story interfaces; new UI and live-provider quality gates remain separate.

## Verified behavior

Desktop and mobile runs cover existing Action/Story Direction settings and profile persistence, no Auto controls or classifier requests, typed and generated-choice scene submissions, separate automatic choice submission, multiselect with Enter, Action reversal, action-only locking, accepted history navigation, independent empty-campaign opening, stale settings conflicts retaining title/style drafts, and replacement with a new accepted turn ID and unchanged turn count.

The stale-settings test first makes Story Direction authoritative, then retains an unsaved Action/title draft while a second player accepts a story-only turn. The subsequent save rejects the stale fence and preserves the draft.

## Mobile correction

At a 320px viewport the workspace previously expanded to 453px because the mobile grid track used an intrinsic minimum. Changing that track to `minmax(0, 1fr)` keeps the document within 320px while preserving local horizontal campaign-rail scrolling. The fresh build passed the opened-profile document-width and dialog-bound assertions. Root also visually inspected the final viewport capture.

## Runtime and source

The image includes the reviewed legacy changes, the two test typing corrections, and the separately reviewed mobile grid correction. It was built from the working tree based on `8f179cc2`; harness checkpoint `488418fa` records the same harness content used for this build. The owned database is `infinitequest_storyonly_6430d0c947e447f2ad8529f46b34301f`, served only at `http://127.0.0.1:18081` by harness session 1187. It remains running for the separate new UI checks; final cleanup is pending their completion. The previous abandoned runtime was removed, and its database removal was verified while the dedicated base database remained running.

```powershell
node node_modules/@playwright/test/cli.js test tests/e2e/story-only-campaigns.e2e.test.ts --config playwright.story-only-runtime.config.ts
```

Fixture environment values came from the owned runtime state file. The text provider is synthetic, so these checks prove application behavior rather than live model quality or speed.

## Screenshots

- [Nexus profile, desktop](screenshots/legacy/management-profile-desktop.png)
- [Nexus profile, mobile](screenshots/legacy/management-profile-mobile.png)
- [Nexus profile, 320px](screenshots/legacy/management-profile-320.png)
- [Story Direction, desktop](screenshots/legacy/player-story-direction-desktop.png)
- [Story Direction, mobile](screenshots/legacy/player-story-direction-mobile.png)
- [Action controls, desktop](screenshots/legacy/player-action-controls-desktop.png)
- [Action controls, mobile](screenshots/legacy/player-action-controls-mobile.png)
- [Story profile, desktop](screenshots/legacy/player-profile-desktop.png)
- [Story profile, mobile](screenshots/legacy/player-profile-mobile.png)

Earlier failure and CSS-injection images are diagnostic artifacts, not final acceptance evidence.
