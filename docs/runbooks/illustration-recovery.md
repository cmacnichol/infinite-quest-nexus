# Recover unattached turn illustrations

Use this procedure after deploying the turn-illustration repair. The repair normalizes nested asset timestamps at the API boundary, keeps provisional sets out of accepted-turn responses, and attaches active provisional sets regardless of whether image generation finished first. Existing images do not need regeneration.

## Historical recovery

1. Back up the database and original asset store using the deployment recovery procedure. Stop API writes and workers while applying this operator repair; the command is not an online worker task.
2. Supply the database connection through `DATABASE_URL` or `DATABASE_URL_FILE`. Use the actual internal owner UUID and one campaign UUID, not imported provenance.
3. Preview candidates from the repaired checkout:

   ```powershell
   corepack pnpm exec tsx scripts/recover-turn-illustrations.ts --owner OWNER_UUID --campaign CAMPAIGN_UUID
   ```

4. Review the `illustration_recovery_report` structured log. `eligible` means the active unattached set has a completed generation with an accepted turn in the same owner/campaign, its segment text matches the accepted narration at the stored offsets, there is no competing active set or narration correction, and no image/prompt work is active. Skipped sets include a reason. Missing parents, mismatched text, and competing sets require individual review; do not force their attachment.
5. Apply the same scope explicitly:

   ```powershell
   corepack pnpm exec tsx scripts/recover-turn-illustrations.ts --owner OWNER_UUID --campaign CAMPAIGN_UUID --apply
   ```

The command attaches existing sets, segments, and their image/prompt jobs in a transaction. It preserves job status, IDs, original assets, accepted narration and campaign state. It creates no jobs and makes no provider requests. It records an `illustration_attachment_recovered` activity event per recovered set. Repeating the command does not reattach already recovered sets.

Restart services and use **Refresh illustrations** on the selected Story turn. Both Story surfaces distinguish invalid server data from load failures. Refresh reads status; it does not regenerate images. Legacy transport polling retries at most three consecutive failures before requiring refresh.

## Verification and rollback

Verify the selected turn shows its existing images and its asset URLs return image content. Confirm no new image jobs or provider charges were created by recovery. Validate skipped rows separately.

No schema migration is required. Application rollback does not undo recovered links; the links use existing fields and constraints. Rolling back the adapter reintroduces the timestamp/response failures, so preserve a repair-capable build. Restore data only through the established backup procedure if recovery must be undone.
