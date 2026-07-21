# Task: User Profile Modal & Turn Choice Auto-Submit Option

Status: In Progress
Started: 2026-07-21

## Action Checklist

- [x] 1. Database & Contracts
  - [x] Create migration `database/migrations/0020_user_settings.sql` adding `settings jsonb NOT NULL DEFAULT '{}'::jsonb` to `users` table.
  - [x] Create `packages/contracts/src/users.ts` with `userSettingsSchema`, `userProfileSchema`, and `userProfileUpdateSchema`.
  - [x] Export users contract from `packages/contracts/src/index.ts`.
- [x] 2. API Service Endpoints
  - [x] Update `GET /api/v1/session` in `services/api/src/server.ts` to include `settings` inside `user`.
  - [x] Add `GET /api/v1/users/me` and `GET /api/v1/user/profile` to return current user profile and settings.
  - [x] Add `PATCH /api/v1/users/me/profile` (and `PUT` aliases) to update display name and merge `settings`.
- [x] 3. New Modular Web Client (`apps/web/public`)
  - [x] Update `story.html` header (`menu-wrap`) with top-right profile icon (`👤`) and `userProfileDialog`.
  - [x] Update `story.css` with premium glassmorphism styling for `.profile-icon-btn`.
  - [x] Update `story.js` to track user settings, open/close profile modal, save profile via API, and check `autoSubmitTurnChoices` before submitting choice clicks.
- [x] 4. Legacy Web Client (`index.html`)
  - [x] Update `index.html` CSS with `.profile-icon-btn` styling.
  - [x] Update `index.html` header (`menu-wrap`) with top-right profile icon (`👤`) and `userProfileDialog`.
  - [x] Update `index.html` JavaScript to fetch profile settings, manage profile modal, and respect `autoSubmitTurnChoices` on choice clicks.
- [x] 5. Verification & Testing
  - [x] Create unit tests for user profile endpoints and settings validation.
  - [x] Run full `npm test` and `npm run check` to ensure all tests pass and TypeScript check succeeds.

## Notes & Resume Context
- Current active user is `initial-owner` resolved by `initialOwnerId(pool)`.
- Default setting for `autoSubmitTurnChoices` is `true`. When `false`, choice clicks populate `freeAction` textarea instead of auto submitting.
