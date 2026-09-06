# Documentation correction pass — 2026-09-05

This pass corrects the documentation findings from the [repository review](./2026-09-05-documentation-accuracy-review.md). The review remains a record of the pre-correction working tree; its original failures and line references are historical evidence.

## Corrections

| Finding | Documentation outcome |
| --- | --- |
| D01 — Site build | Replaced the two links outside the documentation source with repository source URLs. Dead-link enforcement remains enabled. |
| D02 — Illustration lifecycle | Documented accepted-turn and provisional streaming paths, promotion, attempted orphan cleanup, and the unresolved validation-boundary conflict. Added clarification to ADR 0025 and linked the current lifecycle from player, provider, recovery, and capability guides. |
| D03 — Storage | Listed all four Compose volumes and clarified retention, archive operational state, encryption-key escrow, and reset effects in installation, operations, and README guidance. |
| D04 — System Archive | Aligned player, world, campaign, and deployment guidance: enabled direct runtime/single-node Compose, disabled base replicated Swarm, with explicit withdrawal and shared-storage requirements. |
| D05 — Chronicle defaults | Distinguished new campaigns using chunked retrieval with shadow enabled from staged conversion of existing legacy campaigns. Updated configuration and concept guidance, retaining readiness fallback. |
| D06 — Sogni | Distinguished Creative Workflow (REST) from Supernet SDK, including model/network settings, deadlines, filtering controls, persisted-job recovery, and the SDK submission crash window. Preserved existing section anchors. |
| D07 — CSP | Described same-origin browser connections and explicitly allowed image sources without implying authentication. |
| D08 — Integration commands | Added the dedicated integration configuration to focused commands and explained why skipped database cases cannot establish verification. |
| D09 — Unit discovery | Documented explicit nested-worktree exclusions in the README and test guide; applied them to focused unit examples. The underlying runner behavior remains unchanged. |
| D10 — pnpm | Aligned README and installation requirements with the repository's 11.24.0 pin. |
| D11 — Configuration coverage | Documented the world-sharing flag, its routes and access-capability boundary, restart behavior, and the filesystem asset driver. |

The older UI implementation matrix is now explicitly labeled as a historical snapshot rather than current completion evidence.

## Remaining work outside this documentation pass

- The provisional illustration implementation and the required pre-dispatch validation boundary still need an explicit design decision and, if required, a separately tested implementation change. Documenting the conflict does not relax the existing safeguards.
- The unmodified unit script can still discover nested worktree tests. The documented exclusion command provides scoped verification; a permanent root-only discovery change remains code work.
- Live provider behavior, external vendor documentation, deployed-site status, PostgreSQL integration, browser interactions, and deployment/restore procedures are not certified by this pass.

## Verification

The documentation build completed successfully with page rendering and sitemap generation. It emitted a non-fatal large-chunk warning. Dead-link checking was not disabled.

Commands used for the correction pass:

```sh
pnpm --filter @infinite-quest/docs build
pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --reporter=dot
git diff --check
```

The root-scoped unit run passed all 233 test files: 2,739 tests passed and 44 were skipped. The skips include platform-dependent Linux/POSIX and secure-filesystem cases on Windows; those cases remain unverified. The root-scoped unit command is exercised to verify the documented workaround; it is not evidence of database or provider behavior. PostgreSQL integration, live provider, and browser suites are outside this documentation-only change. Application source, test configuration, deployment manifests, and existing agent-instruction edits were preserved. No commit or deployment was performed.
