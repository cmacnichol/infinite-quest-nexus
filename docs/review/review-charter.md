# Infinite Quest Nexus Review Charter

> Defines what this codebase was evaluated against, given that no trustworthy
> current specification or implementation plan exists. Companion to
> `as-built-specification.md` and `code-review-report.md`.

## 1. Why a charter is needed

The reviewed repository has extensive documentation (174 Markdown files) but no
authoritative, current product specification, and the project inputs for this
review recorded `Known users or system purpose: UNKNOWN`. Existing behavior
therefore cannot be assumed intentional, and existing tests cannot be assumed
correct.

Absent a specification, findings were held to two standards: **universal
engineering expectations** (§2), which apply to any production-shaped system,
and **requirement-alignment rules** (§3), which govern when a behavior may be
called a requirement violation.

## 2. Universal engineering expectations

The system was evaluated on whether it:

1. Preserves data integrity.
2. Enforces the authorization boundaries it actually claims to enforce.
3. Handles untrusted input safely.
4. Fails without corrupting state.
5. Avoids exposing secrets and sensitive data.
6. Uses resources within bounded limits.
7. Handles retries and concurrency safely.
8. Produces actionable error information.
9. Supports reasonable operational diagnosis.
10. Can be built, tested, deployed, and recovered using repository evidence.
11. Behaves consistently with its explicit public interfaces and schemas.
12. Avoids contradictions between components.
13. Avoids demonstrable regressions.
14. Has meaningful validation for high-risk behavior.

### Scope adjustment for the documented pre-authentication posture

`README.md:13, 122` documents that interactive authentication is not
implemented and that the deployment targets a trusted network. Accordingly:

- **Absence of authentication is not reported as a defect.** It is a documented
  current limitation.
- **In scope:** any place where the code contradicts that documented posture —
  for example trusting browser-supplied identity for authorization, or an
  ownership predicate that can be bypassed.
- **In scope:** controls the repository documents as required *despite* the
  pre-auth posture — notably the P0 network-security design's admission
  control, origin policy, and provider destination policy.
- Expectation 2 is therefore read as "enforces the boundaries it claims,"
  not "implements authentication."

## 3. Requirement-alignment rules

A behavior was called a **requirement violation** only when supported by at
least one of:

- a documented requirement in current repository documentation;
- stakeholder-supplied desired behavior (none available for this review);
- a public API or schema contract;
- a clear system invariant (`as-built-specification.md` §20);
- strong historical evidence that remains current;
- a direct contradiction between two components of the system.

Where intended behavior could not be established, the issue was classified as
**human decision required**, **documentation gap**, **ambiguous behavior**, or
**potential defect pending confirmation** — never as a confirmed bug.

Behaviors observed but not established as requirements are recorded in
`as-built-specification.md` §22 rather than reported as findings.

## 4. What is explicitly *not* a finding

Per the review method, none of the following was reported as a defect on its own.
Each was treated only as a lead directing where to read live source:

- a RepoWise health score, risk score, or hotspot flag;
- a semantic search result or inferred dependency;
- a generated wiki statement;
- a code-complexity metric (e.g. `generation-service.ts` max CCN 146);
- high churn;
- low or absent test coverage;
- an undocumented behavior;
- a divergence from general style preference;
- a theoretical vulnerability class with no demonstrated reachable path;
- an optimization preference with no concrete risk scenario;
- an architecture that is merely unconventional.

Two specific RepoWise signals were verified and **rejected** as findings:

| Signal | Why rejected |
| --- | --- |
| `untested_hotspot` on `asset-service.ts`, `server.ts`, `memory-service.ts`, etc. | The biomarker means "no *paired* test file". Live verification shows `asset-service` alone is exercised by 6 test files. The repository tests through central `tests/unit` and `tests/integration` suites. |
| `get_dead_code()` returning zero findings at ≥0.7 confidence | Inverse error: it missed a genuinely unreachable subsystem because integration tests reference it. Live tracing found it (REV-001). |

## 5. Evidence hierarchy

Applied in this order, highest first:

1. Live repository source at `58d0aa2f9374` and exact Git state.
2. Executed command results (`pnpm check`, unit suite, attempted integration suite).
3. Explicit repository documentation.
4. Existing tests, schemas, migrations, configuration, public interfaces.
5. Git history.
6. RepoWise generated context, scores, and inferences.
7. Reviewer inference.

Where RepoWise and live source disagreed, live source won and the disagreement
was recorded (`code-review-report.md` §3).

## 6. Finding requirements

Every finding must carry: **ID, severity, confidence, category, exact location,
evidence, evidence classification, failure scenario, blast radius, recommended
correction, validation method, and RepoWise role.**

No finding may rest solely on RepoWise output, a score, a semantic search hit,
an unconfirmed dependency, or reviewer preference.

## 7. Severity definitions

| Severity | Definition |
| --- | --- |
| **Critical** | Likely broad compromise, irrecoverable or widespread data loss, remote code execution, catastrophic deployment failure, or system-wide outage with no practical mitigation. |
| **High** | Likely authorization bypass, serious data corruption, major failure of a required function, unsafe migration or deployment, significant outage, or high-impact regression. |
| **Medium** | A real defect with limited scope, recoverable operational risk, meaningful security weakness, performance issue, test gap on a high-risk path, or an architecture problem likely to cause rework or failure. |
| **Low** | A narrow correctness risk, observability gap, minor maintainability risk with concrete impact, or an evidence-supported inconsistency. |

## 8. Confidence definitions

| Confidence | Meaning |
| --- | --- |
| **Confirmed** | Demonstrated by live source plus executed verification; the reviewer reproduced the condition or proved it by exhaustive search. |
| **High** | Live source proves the condition; the failure scenario is a direct consequence but was not executed. |
| **Medium** | Strong source evidence with a plausible but unproven trigger. |
| **Low** | Suggestive evidence; requires investigation before action. |

Severity and confidence are recorded independently and were not inflated. A
documented-but-unenforced control is rated on the impact of its absence, tempered
by the documented trusted-network deployment context.

## 9. Prioritization order

Review effort was allocated in this order:

1. Authentication and authorization boundaries (as documented)
2. Data persistence and migrations
3. Public interfaces
4. Untrusted input handling
5. External integrations and egress
6. Background jobs and concurrency
7. High-centrality components
8. High-risk / low-health components
9. High-churn components
10. Deployment and rollback
11. Shared utilities crossing trust boundaries
12. Components with weak or missing validation

Reviewer-specified areas of special concern — **legacy code, unused code, and
performance** — were treated as a cross-cutting overlay applied at every step.

## 10. Constraints observed during this review

- **Read-only.** No application code, tests, configuration, dependencies,
  migrations, infrastructure, or deployment resources were modified.
- **Writes limited to `docs/review/`** — three files, all new.
- No commit, push, amend, reset, rebase, merge, dependency install, lockfile
  change, deployment, or database mutation was performed.
- The working tree was neither cleaned nor reset; the pre-existing
  `AGENTS.md` modification and untracked `docs/prompts/` were left untouched.
- The documented integration-test database reset was **declined** because it
  destroys a Docker volume and local credentials — outside a read-only mandate.
  The integration suite is therefore reported as not validated rather than
  passing or failing.
- No temporary files were created in the repository. Command output was written
  only to the session scratch directory outside the repository.

## 11. Deliverables

| File | Purpose |
| --- | --- |
| `docs/review/as-built-specification.md` | Evidence-classified record of what the system demonstrably does. |
| `docs/review/review-charter.md` | This document — the standard applied. |
| `docs/review/code-review-report.md` | Prioritized findings, unknowns, coverage, and recommendation. |

None of these is an approved product specification. Converting the as-built
document into a target-state specification requires the human validation process
described in `code-review-report.md` §13.
