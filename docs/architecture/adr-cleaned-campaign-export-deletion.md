# Release cleaned campaign export metadata during campaign deletion

Date: 2026-08-31

Status: Accepted

## Context

Campaign ZIP delivery records retain a foreign key to their campaign even after
the export file is cleaned. Their original blanket deletion guard made a campaign
permanently undeletable after export, returning a foreign-key error to the API.

## Decision

Campaign deletion removes only its owner's cleaned campaign export records in
the same transaction as the campaign. Any export not yet cleaned contributes an
`export` blocker to the existing `deletion_blocked` response. Expiry alone does
not prove cleanup and never authorizes deletion.

Migration 0083 permits deletion of a `campaign_zip` artifact only when both the
artifact and its matching, owner-scoped filesystem operation are `cleaned`.
Filesystem journals and descriptors remain retained. Export insertion,
write-once scope, lifecycle transitions, and world/system export deletion guards
are unchanged. The existing campaign row lock serializes deletion with export
issuance, whose scope validation locks the campaign before publishing authority.

## Deployment and rollback

Deploy migration 0083 before the updated API code, through the normal migration
runner. The migration changes guards only; it does not delete existing data.
The live campaign is removed only by a later explicit campaign-delete request.

Rollback the API code before reverting 0083. The down migration reinstates the
blanket artifact deletion guard; it cannot recreate metadata or campaigns
already explicitly deleted. Restoring deleted content requires an archive or
disaster-recovery backup. World deletion after world exports and other retained
portable import references are outside this targeted fix.

## Verification

`tests/integration/campaign-delete-exports.integration.test.ts` exercises the
production repository against PostgreSQL, including cleaned exports, all
unfinished export states, retained cleanup journals, owner/campaign isolation,
title confirmation, and deferred cleanup mismatch protection.
