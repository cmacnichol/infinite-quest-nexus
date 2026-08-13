# Claude Repository Archaeology and Code Review Prompt with RepoWise

> Use this prompt in a fresh Claude Code session started from the repository root.
>
> This version is designed for an existing codebase that has **no reliable current specification and no implementation plan**.
>
> Replace every placeholder in square brackets before beginning. Use `None` where a value genuinely does not apply.

---

## Project Inputs

- **Repository or project name:** `Infinnite-Quest-Nexus`
- **Review scope:** `ENTIRE REPOSITORY`
- **Current branch:** `main`
- **Target revision:** `CURRENT_HEAD`
- **Optional comparison baseline:** `None`
- **Known test commands:** `AUTO_DISCOVER`
- **Known build, lint, or type-check commands:** `AUTO_DISCOVER`
- **Relevant deployment environment:** `Docker`
- **Known users or system purpose:** `UNKNOWN`
- **Known operational constraints:** `NONE`
- **Areas of special concern:** `Legacy Code, Unused Code, Performance`

---

# Role

Act as an independent senior software engineer, software architect, repository archaeologist, and adversarial code reviewer.

This is an existing codebase without a trustworthy current specification or implementation plan.

Your job is to:

1. Establish the exact repository and RepoWise index state
2. Discover the system architecture and behavior
3. Recover an evidence-based **as-built specification**
4. Create a **review charter**
5. Review the current codebase for correctness, security, reliability, data integrity, test quality, deployment risk, and maintainability
6. Distinguish verified defects from unknown or undocumented product decisions
7. Produce a prioritized, evidence-backed review report
8. Recommend the minimum safe next steps
9. Propose a target-state specification and implementation-planning process only after findings are validated

Do not invent original requirements.

Do not assume that current behavior is intended merely because it exists.

Do not assume that comments, tests, names, or generated documentation accurately express product intent.

Do not modify application code, tests, configuration, dependencies, migrations, infrastructure, generated files, or deployment resources.

You may create or update review documentation only under:

```text
docs/review/
```

Create these files:

```text
docs/review/as-built-specification.md
docs/review/review-charter.md
docs/review/code-review-report.md
```

Do not commit, push, amend, reset, rebase, merge, install dependencies, update lockfiles, deploy, change external resources, modify databases, or perform destructive operations.

This is a documentation and read-only assessment.

If a harmless command creates temporary files, disclose them and remove them before finishing.

---

# Core Review Principles

Use the following evidence hierarchy:

1. Live repository source and exact current Git state
2. Executed test, build, lint, type-check, and diagnostic results
3. Explicit repository documentation and externally supplied project context
4. Existing tests, schemas, migrations, configuration, and public interfaces
5. Git history, issues, pull requests, and release history when available
6. RepoWise generated context, architecture, scores, summaries, and inferences
7. Reviewer inference

RepoWise is a discovery and prioritization tool. It is not the final source of truth.

Use RepoWise to locate:

- Architecture
- Dependencies
- Callers and consumers
- Change risk
- Historical context
- Co-change relationships
- Hotspots
- Ownership
- Relevant tests
- Architectural decisions
- Likely blast radius

Use the live repository and executable evidence to prove or disprove every material finding.

Do not report any of the following as a defect by itself:

- A RepoWise health score
- A RepoWise risk score
- A semantic search result
- An inferred dependency
- A generated wiki statement
- A code-complexity metric
- High churn
- Low test coverage
- An undocumented behavior
- A difference from common style preferences

These are investigation leads, not findings.

Be skeptical but evidence-driven.

Do not assume:

- Existing behavior is intended
- Existing tests are correct
- Passing tests prove product correctness
- A missing test proves a runtime defect
- Documentation is current
- RepoWise is current
- Git history reveals complete business intent
- A high-risk component is defective
- A low-risk component is safe
- Unusual architecture is necessarily wrong
- A broad rewrite is preferable to a focused correction

---

# Evidence Classification

Every substantial behavioral or requirement statement must be classified as one of the following:

## Documented

Explicitly stated in current repository documentation, external project context supplied for this review, formal schemas, public API contracts, or authoritative configuration.

## Observed

Directly demonstrated by live source code, executable behavior, current tests, migrations, schemas, or command results.

## Historically supported

Supported by Git history, issue history, pull requests, release notes, or prior architectural decisions, but not clearly documented as a current requirement.

## Inferred

Strongly suggested by repository structure, naming, repeated patterns, RepoWise context, or reviewer analysis, but not proven.

## Desired

Explicitly provided by a human stakeholder as intended future or current behavior.

## Unknown

Requires human confirmation or business decision.

Never silently upgrade an **Observed**, **Historically supported**, or **Inferred** statement into a required product behavior.

---

# Phase 1: Establish Repository State

Before analyzing architecture or behavior, establish the exact repository state.

Run safe read-only commands such as:

```bash
pwd
git status --short
git branch --show-current
git rev-parse --show-toplevel
git rev-parse HEAD
git log --oneline --decorate -n 30
git remote -v
```

If `[BASELINE_BRANCH_OR_COMMIT_OR_NONE]` is provided, also run:

```bash
git rev-parse [BASELINE_BRANCH_OR_COMMIT_OR_NONE]
git diff --stat [BASELINE_BRANCH_OR_COMMIT_OR_NONE]..HEAD
git diff --name-status [BASELINE_BRANCH_OR_COMMIT_OR_NONE]..HEAD
```

If the working tree is not clean, inspect separately:

```bash
git diff
git diff --cached
```

Do not assume uncommitted work is represented by `HEAD`.

Record:

- Repository root
- Repository identity
- Current branch
- Current `HEAD`
- Optional baseline revision
- Working-tree cleanliness
- Staged changes
- Unstaged changes
- Untracked files
- Submodules or nested repositories
- Review scope
- Any exclusions
- Exact revision or working-tree state reviewed

Do not modify or clean the working tree.

---

# Phase 2: Verify RepoWise Availability and Freshness

Confirm that RepoWise MCP tools are available.

Use RepoWise to retrieve repository status, overview, index metadata, and available capabilities.

Determine, where the available tools permit:

- Repository indexed by RepoWise
- Indexed root
- Indexed commit or revision
- Current Git `HEAD`
- Whether indexing is complete
- Whether the index is stale
- Whether uncommitted changes are represented
- Whether files, symbols, relationships, or history were omitted
- Whether any context is truncated
- Whether the requested review scope is fully indexed
- Whether generated architectural information has freshness metadata

Do not initiate a full index or update unless explicitly authorized.

If the RepoWise index does not match the exact repository state under review:

- Continue using RepoWise for broad discovery
- Mark the index stale or partial
- Treat all indexed relationships and summaries as potentially outdated
- Verify material conclusions against live source and Git
- Explicitly list unindexed or potentially stale areas
- Do not claim complete RepoWise coverage

When RepoWise and the live repository disagree, the live repository takes precedence.

Record disagreements because they may indicate:

- Stale indexing
- Architectural drift
- Misleading documentation
- Generated-context limitations
- Renamed or removed components
- Uncommitted changes
- A genuine codebase inconsistency

---

# Phase 3: Repository Discovery

Perform repository archaeology before starting defect review.

Inspect:

- `README` files
- `AGENTS.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- Architecture documentation
- Design records and ADRs
- Package and dependency manifests
- Lockfiles
- Directory structure
- Application entry points
- API routes
- Commands and CLIs
- Public interfaces
- Data models
- Schemas
- Migrations
- Authentication
- Authorization
- Input validation
- External integrations
- Background workers
- Queues
- Scheduled jobs
- Environment variables
- Configuration
- Feature flags
- Tests and fixtures
- CI/CD workflows
- Container files
- Infrastructure definitions
- Deployment manifests
- Logging
- Metrics
- Tracing
- Health checks
- Backup and recovery logic
- Recent Git history
- Relevant issues and pull requests if accessible
- Release notes and changelogs
- Generated code boundaries
- Vendored code
- Experimental or deprecated paths

Use RepoWise to help identify:

- Major architectural communities
- High-centrality components
- High-churn areas
- Low-health or complex areas
- Likely entry points
- Dependency hubs
- Ownership or knowledge silos
- Historically co-changed files
- Relevant architectural decisions
- Likely tests for each component
- Areas with unusually high change risk

Do not begin by reading every file linearly unless the repository is small.

Use RepoWise and repository structure to construct a systematic coverage plan, then inspect live source.

---

# Phase 4: Build the Architecture Map

Create an evidence-backed architecture map covering:

## System purpose

Describe what the repository appears to provide.

Classify the purpose as:

- Documented
- Observed
- Historically supported
- Inferred
- Unknown

## Users and actors

Identify:

- Human users
- Administrators
- Operators
- Service accounts
- External systems
- Scheduled processes
- Background workers
- Anonymous or untrusted actors

Do not invent roles not supported by evidence.

## Major components

For each major component, document:

- Responsibility
- Entry points
- Inputs
- Outputs
- Dependencies
- Consumers
- Data owned
- External systems used
- Error behavior
- Related tests
- Operational significance
- Evidence classification

## Data and control flow

Trace major workflows from:

- Input
- Validation
- Authentication
- Authorization
- Core processing
- Persistence
- External calls
- User-visible or system-visible output
- Logging and telemetry
- Failure handling
- Retry behavior
- Cleanup or rollback

## Trust boundaries

Identify:

- Internet or external input boundaries
- User-to-service boundaries
- Service-to-service boundaries
- Privilege boundaries
- Tenant boundaries
- Process boundaries
- Database boundaries
- File-system boundaries
- Plugin or extension boundaries
- CI/CD and deployment boundaries
- Secret boundaries

## Operational model

Identify:

- Runtime platforms
- Deployment topology
- Required services
- Stateful components
- Persistence
- Startup ordering
- Health checks
- Scaling assumptions
- Failure recovery
- Backups
- Rollback mechanisms
- Environment-specific behavior

Use RepoWise context, dependency analysis, Git history, and live source.

Clearly label every architectural conclusion by evidence classification.

---

# Phase 5: Recover the As-Built Specification

Create:

```text
docs/review/as-built-specification.md
```

This document describes what the current repository demonstrably does.

It is not a claim about original intent and is not automatically a target-state specification.

Use this structure:

```markdown
# [Project Name] As-Built Specification

## 1. Review Metadata

- Repository:
- Branch:
- Revision:
- Working-tree state:
- Review scope:
- RepoWise indexed revision:
- RepoWise freshness:
- Generated date:

## 2. Evidence Classification

Define Documented, Observed, Historically Supported, Inferred, Desired, and Unknown.

## 3. System Purpose

## 4. Users, Roles, and External Actors

## 5. Architecture Overview

## 6. Components and Responsibilities

## 7. Public Interfaces

## 8. Primary Workflows

## 9. Data Model and Persistence

## 10. Authentication and Authorization

## 11. Trust Boundaries

## 12. Configuration and Feature Flags

## 13. External Integrations

## 14. Background and Scheduled Processing

## 15. Error Handling and Recovery

## 16. Concurrency and Idempotency

## 17. Logging, Metrics, and Observability

## 18. Deployment and Operational Model

## 19. Tests and Validation

## 20. Known System Invariants

## 21. Documented Requirements

## 22. Observed Behaviors

## 23. Historically Supported Intent

## 24. Inferred Requirements

## 25. Unknowns Requiring Human Decisions

## 26. Evidence Index

## 27. Coverage and Limitations
```

For every substantial claim:

- Provide file and line references
- Provide command or test evidence when applicable
- State the evidence classification
- Note uncertainty
- Note RepoWise assistance when it influenced discovery

Do not describe a defect as intended behavior merely because the code currently does it.

Do not use the as-built specification to normalize unsafe behavior.

---

# Phase 6: Create the Review Charter

Create:

```text
docs/review/review-charter.md
```

The review charter defines what the codebase will be evaluated against in the absence of a formal specification.

Use these review standards:

## Universal engineering expectations

Evaluate whether the system:

- Preserves data integrity
- Enforces observable authentication and authorization boundaries
- Handles untrusted input safely
- Fails without corrupting state
- Avoids exposing secrets and sensitive data
- Uses resources within bounded limits
- Handles retries and concurrency safely
- Produces actionable error information
- Supports reasonable operational diagnosis
- Can be built, tested, deployed, and recovered using repository evidence
- Behaves consistently with explicit public interfaces and schemas
- Avoids contradictions between components
- Avoids demonstrable regressions
- Has meaningful validation for high-risk behavior

## Requirement-alignment rules

A behavior may be called a requirement violation only when supported by:

- Documented requirement
- Desired stakeholder behavior
- Public API or schema contract
- Clear system invariant
- Strong historical evidence that remains current
- Direct contradiction between system components

When intended product behavior is unknown, classify the issue as:

- Human decision required
- Documentation gap
- Ambiguous behavior
- Potential defect pending confirmation

Do not present uncertain product choices as confirmed bugs.

## Finding evidence requirement

Every finding must include:

- Stable ID
- Severity
- Confidence
- Category
- Exact location
- Evidence
- Failure scenario
- Blast radius
- Recommended correction
- Validation method
- Evidence classification

## Severity definitions

### Critical

Likely broad compromise, irrecoverable or widespread data loss, remote code execution, catastrophic deployment failure, or system-wide outage without practical mitigation.

### High

Likely authorization bypass, serious data corruption, major required-function failure, unsafe migration or deployment, significant outage, or high-impact regression.

### Medium

A real defect with limited scope, recoverable operational risk, meaningful security weakness, performance issue, test gap on a high-risk path, or architecture problem likely to cause rework or failure.

### Low

A narrow correctness risk, observability gap, minor maintainability risk with concrete impact, or evidence-supported inconsistency.

## Confidence definitions

- Confirmed
- High
- Medium
- Low

Do not inflate severity or confidence.

---

# Phase 7: Establish Review Coverage

Create a repository coverage inventory.

For every in-scope file or component, classify its review outcome as:

- Reviewed in depth
- Reviewed for interfaces and dependencies
- Reviewed through tests or execution
- Sampled
- Generated or vendored
- Excluded with reason
- Not reviewed
- Blocked
- RepoWise-only discovery, not source-verified

For a large repository, prioritize:

1. Authentication and authorization
2. Data persistence and migrations
3. Public interfaces
4. Untrusted input
5. External integrations
6. Background jobs
7. High-centrality components
8. High-risk or low-health components
9. High-churn components
10. Deployment and rollback
11. Shared utilities used across trust boundaries
12. Components with weak or missing tests

Do not claim a complete repository review when material areas remain unreviewed.

---

# Phase 8: RepoWise-Assisted Risk and Blast-Radius Analysis

Use RepoWise risk, context, architecture, history, and dependency capabilities where available.

For the entire review scope, identify:

- High-centrality components
- Transitive dependents
- Callers and callees
- Importers and consumers
- Public interfaces
- Shared state
- High-churn areas
- Historically defect-prone areas
- Historically co-changed files
- Untested hotspots
- Low-health or complex components
- Ownership or knowledge silos
- Security-sensitive components
- Data-sensitive components
- Deployment-critical components
- Architectural decisions
- Stale architectural decisions
- Components with missing architectural rationale

If a baseline revision is supplied, additionally analyze:

```text
[BASELINE_BRANCH_OR_COMMIT_OR_NONE]..HEAD
```

For a baseline comparison, identify:

- Directly changed files
- Transitive impact
- Omitted co-change partners
- Tests affected
- Migration or configuration impact
- Deployment impact
- Compatibility risk
- Rollback risk

Do not report a risk score as a finding.

Use risk information to decide where to inspect source and run tests.

For each material component, retrieve RepoWise context where available:

- Purpose
- Symbols
- Interfaces
- Callers
- Callees
- Dependents
- Architectural community
- Centrality
- Complexity or health
- Ownership
- Recent history
- Architectural decisions
- Related tests
- Freshness
- Truncation

Verify every important relationship in live source before relying on it in a finding.

---

# Phase 9: Search for Related and Conflicting Paths

Use RepoWise semantic search and normal repository search to identify:

- Duplicate implementations
- Parallel code paths
- Legacy paths
- Dead or abandoned code
- Existing validation helpers
- Existing authorization enforcement
- Existing error-handling patterns
- Existing recovery mechanisms
- Existing compatibility shims
- Existing migrations
- Existing feature flags
- Existing tests and fixtures
- Hidden consumers
- Alternate configuration paths
- Environment-specific behavior
- Inconsistent schemas
- Conflicting source-of-truth definitions
- Copied code that has diverged
- Interfaces used differently across modules

Use multiple terms when concepts have:

- Legacy names
- Abbreviations
- Domain-specific vocabulary
- Renamed entities
- Similar but not identical implementations

Do not assume the first semantic result is complete.

---

# Phase 10: Functional Correctness Review

Review for:

- Contradictory behavior between components
- Incorrect state transitions
- Broken workflows
- Invalid assumptions
- Missing boundary handling
- Off-by-one errors
- Null or empty-state errors
- Incorrect defaults
- Unreachable expected behavior
- Unexpected side effects
- Incorrect serialization
- Schema mismatches
- Incorrect time, date, locale, or timezone handling
- Incorrect feature-flag behavior
- Error states reported as success
- Success states reported as failure
- Broken compatibility paths
- Dead code affecting active behavior
- Public interface behavior inconsistent with implementation
- Tests contradicting runtime behavior
- Inconsistent behavior across equivalent paths

When product intent is unknown:

- Describe the observable inconsistency
- Explain the concrete failure scenario
- State what human decision is required
- Do not claim a confirmed requirement violation without evidence

---

# Phase 11: Security Review

Review for:

- Authentication bypass
- Authorization bypass
- Missing role checks
- Missing ownership checks
- Insecure direct object references
- Tenant-boundary violations
- Input validation gaps
- Injection
- Unsafe deserialization
- Path traversal
- Unsafe file handling
- Server-side request forgery
- Cross-site scripting
- Cross-site request forgery
- Secret exposure
- Sensitive logging
- Insecure defaults
- Trust-boundary violations
- Improper error disclosure
- Denial-of-service risks
- Unbounded work
- Unsafe cryptography
- Insecure randomness
- Missing signature verification
- Replay risks
- Dependency and supply-chain risks
- Unsafe plugin or extension handling
- CI/CD credential exposure
- Deployment privilege issues

Confirm reachability and concrete impact.

Do not report theoretical vulnerability classes without evidence of a reachable path.

If security scope is broad or high stakes, recommend a separate dedicated threat model and repository security scan after this general review.

---

# Phase 12: Data Integrity Review

Review for:

- Data loss
- Partial writes
- Incorrect transactions
- Missing rollback
- Duplicate processing
- Missing idempotency
- Incorrect retry behavior
- Unsafe migrations
- Destructive defaults
- Null assumptions
- Referential-integrity issues
- Schema drift
- Serialization mismatch
- Precision loss
- Incorrect uniqueness enforcement
- Stale-cache writes
- Cross-tenant data mixing
- Inconsistent source-of-truth behavior
- Backup or recovery gaps
- Irreversible operations without safeguards

Trace data-sensitive workflows end to end.

---

# Phase 13: Concurrency and Asynchronous Review

Review for:

- Race conditions
- Lost updates
- Deadlocks
- Duplicate jobs
- Incorrect locking
- Incorrect ordering assumptions
- Retry storms
- Timeout handling
- Cancellation handling
- Stale reads
- Check-then-act races
- Unbounded concurrency
- Leaked tasks
- Incorrect queue acknowledgement
- Missing idempotency keys
- Partial failure across distributed operations
- Cleanup not performed after interruption

Only report concurrency issues when a plausible execution path exists.

---

# Phase 14: Error Handling and Recovery Review

Review for:

- Swallowed errors
- Misleading error messages
- Errors converted to success
- Incorrect retry behavior
- Missing compensating action
- Incomplete cleanup
- Missing timeout
- Unbounded loops
- Unsafe fallback
- Inconsistent exit codes
- Unobservable failure
- Logging without enough context
- Logging sensitive context
- Retry of non-idempotent operations
- Failure to release resources
- Recovery steps inconsistent with deployment behavior
- Failure states that require undocumented manual repair

Distinguish:

- Defect
- Operational limitation
- Documentation gap
- Unknown product decision

---

# Phase 15: Performance and Resource Review

Review for:

- N+1 access patterns
- Repeated I/O in loops
- Unbounded memory growth
- Missing pagination
- Excessive network calls
- Missing batching
- Poor caching behavior
- Cache invalidation errors
- Leaked handles
- Leaked connections
- Unbounded queues
- Unbounded input size
- Blocking work on critical paths
- Excessive startup work
- Expensive serialization
- Inefficient high-centrality utilities
- Repeated parsing or compilation
- Performance assumptions unsupported by limits or tests

Do not report optimization preferences without a concrete risk scenario.

---

# Phase 16: Compatibility and Operational Review

Review for:

- Breaking public API changes
- Configuration incompatibility
- Environment-variable ambiguity
- Platform-specific failure
- Dependency-version conflict
- Build or packaging failure
- Startup-order assumptions
- Missing readiness or health checks
- Mixed-version deployment problems
- Migration sequencing
- Rollback feasibility
- Missing observability
- Insufficient logs
- Insufficient metrics
- Deployment privilege problems
- Unsafe default exposure
- Missing backup or restore path
- Environment drift
- Development-only behavior reaching production
- Production-only paths lacking validation
- Configuration accepted but ignored
- Configuration precedence inconsistencies

Use repository deployment and CI artifacts as evidence.

---

# Phase 17: Maintainability and Architecture Review

Only report maintainability issues with concrete engineering impact.

Review for:

- Duplicated behavior likely to diverge
- Excessive coupling
- Hidden side effects
- Circular dependencies
- Unclear component ownership
- High-centrality modules with unsafe complexity
- Divergent copies of shared logic
- Dead code affecting comprehension or behavior
- Temporary compatibility paths with no removal conditions
- Generated code edited manually
- Unstable interfaces
- Components violating repeated repository patterns
- Architecture decisions contradicted by active code
- Source-of-truth duplication
- Test architecture that prevents meaningful validation

Do not recommend broad rewrites merely because another architecture would be cleaner.

Prefer focused corrections and explicit follow-up decisions.

---

# Phase 18: Tests and Validation

Discover authoritative commands from:

- Repository documentation
- Package manifests
- Build scripts
- CI/CD workflows
- Makefiles
- Task runners
- Container definitions
- Existing developer scripts

Run safe existing commands when practical.

Do not:

- Install missing dependencies
- Modify lockfiles
- Change configuration
- Start destructive services
- Reset databases
- Alter external resources
- Run production deployment commands

For every command, record:

- Command
- Working directory
- Result
- Relevant output
- Duration if available
- Whether failure appears pre-existing
- Whether failure may be environmental
- Whether failure is likely caused by current code
- Limitations in interpretation

Review test quality for:

- Missing unit tests
- Missing integration tests
- Missing end-to-end tests
- Missing regression tests
- Missing negative tests
- Missing authorization tests
- Missing migration tests
- Missing rollback tests
- Missing concurrency tests
- Missing boundary tests
- Weak assertions
- Tests mirroring implementation details
- Brittle mocks
- Invalid fixtures
- Disabled tests
- Skipped tests
- Environment mismatch
- High-risk code without meaningful validation
- Tests that pass despite broken behavior

Do not claim a command passed unless it was executed against the reviewed repository state or direct trustworthy output from that exact state is available.

---

# Phase 19: Identify Unknowns and Human Decisions

Create a separate list of questions that cannot be answered from repository evidence.

Examples:

- Whether behavior is intended
- Whether a role should have permission
- Whether deletion should be permanent
- Whether backward compatibility is required
- Whether data retention is required
- Whether an external integration is still active
- Whether an obsolete path may be removed
- Whether a migration may be destructive
- Whether a deployment topology is still supported
- Whether a documented workflow is current
- Whether a system invariant is business-critical

For each unknown include:

- Question
- Why it matters
- Evidence inspected
- Available options
- Risk of choosing incorrectly
- Recommended default only when engineering evidence supports one

Do not invent business decisions.

---

# Finding Standards

Only report findings supported by:

- Live repository evidence
- Executed validation
- Explicit documentation
- Public interface or schema contract
- Strong historical evidence
- A clearly demonstrated contradiction
- A concrete engineering invariant
- A reachable failure scenario

Do not inflate severity.

Do not report duplicates.

Do not hide uncertainty.

For each finding include:

1. **ID**
   - Stable identifier such as `REV-001`

2. **Severity**
   - Critical
   - High
   - Medium
   - Low

3. **Confidence**
   - Confirmed
   - High
   - Medium
   - Low

4. **Category**
   - Functional correctness
   - Security
   - Data integrity
   - Concurrency
   - Error handling
   - Performance
   - Compatibility
   - Migration
   - Deployment
   - Observability
   - Testing
   - Architecture
   - Maintainability
   - Documentation
   - Human decision required

5. **Location**
   - File and line range
   - Component
   - Commit or history reference
   - Configuration or deployment artifact

6. **Issue**
   - Concise description

7. **Evidence**
   - Exact code, command result, test result, contract, documentation, or history

8. **Evidence classification**
   - Documented
   - Observed
   - Historically supported
   - Inferred
   - Desired
   - Unknown

9. **Failure scenario**
   - Concrete example showing incorrect behavior, security exposure, data loss, operational failure, rework, or risk

10. **Blast radius**
    - Components, users, environments, or data affected

11. **Recommended correction**
    - Smallest reasonable correction

12. **Validation**
    - Test or verification proving the correction

13. **RepoWise role**
    - Whether RepoWise helped discover or prioritize the issue
    - Never use RepoWise alone as proof

A finding must not rely solely on:

- RepoWise wiki content
- RepoWise summary
- Semantic search
- Health score
- Risk score
- Inferred architecture
- Inferred architectural decision
- Unconfirmed dependency
- Reviewer preference

When intended behavior is unknown, either:

- Report a concrete universal engineering defect, or
- Classify it as a human decision or documentation gap

Do not disguise uncertain product intent as a confirmed defect.

---

# Required Output Files

## 1. `docs/review/as-built-specification.md`

Create the full evidence-based as-built specification defined above.

## 2. `docs/review/review-charter.md`

Create the review charter defined above.

## 3. `docs/review/code-review-report.md`

Use the exact structure below.

---

# Required Code Review Report Structure

## 1. Executive Summary

Include:

- Overall repository condition
- Review scope
- Confidence level
- Whether the codebase is safe to continue building upon
- Most important confirmed risks
- Most important unknowns
- Most important validation gaps
- Recommended immediate next action
- Final recommendation category

Choose one:

- Continue normal development
- Continue after minor corrections
- Pause and address high-priority findings
- Stop and correct critical implementation risks
- Stop pending required human decisions
- Insufficient evidence for a reliable recommendation

---

## 2. Repository and Review State

Include:

- Repository path
- Repository identity
- Current branch
- Current `HEAD`
- Baseline revision if supplied
- Working-tree status
- Staged changes
- Unstaged changes
- Untracked files
- Review scope
- Exclusions
- Commands used to establish state
- Material limitations

---

## 3. RepoWise Analysis

Include:

- RepoWise availability
- Indexed repository
- Indexed root
- Indexed commit or revision
- Current Git `HEAD`
- Freshness status
- Index completeness
- Uncommitted-change coverage
- Tools used
- Architecture summary
- High-centrality components
- High-risk or low-health components
- Important dependents
- Historical co-change relationships
- Relevant architectural decisions
- Ownership or knowledge-silo signals
- Truncated or unavailable context
- Differences between RepoWise and live source
- How RepoWise affected review priorities

Do not dump raw tool output unless necessary as evidence.

---

## 4. Recovered System Summary

Summarize:

- Apparent system purpose
- Main users and actors
- Major workflows
- Major components
- Data stores
- External integrations
- Security boundaries
- Operational model
- Confidence and evidence classification

---

## 5. As-Built Behavior Matrix

Use:

| Area or Workflow | Current Behavior | Evidence Classification | Evidence | Confidence | Unknowns |
|---|---|---|---|---|---|

Do not label observed behavior as intended without evidence.

---

## 6. Architecture and Trust-Boundary Assessment

Include:

- Architecture strengths
- Architecture risks
- Trust boundaries
- High-centrality dependencies
- Single points of failure
- Shared-state risks
- Security-sensitive paths
- Data-sensitive paths
- Operational dependencies
- Architectural drift
- Unknown architecture decisions

---

## 7. Findings

Group by severity:

### Critical

### High

### Medium

### Low

Use the full finding format.

If a severity group has no findings, state `None`.

---

## 8. Human Decisions and Requirement Unknowns

Use:

| Decision or Unknown | Why It Matters | Evidence Reviewed | Options | Risk of Wrong Choice | Recommended Default |
|---|---|---|---|---|---|

Do not invent product decisions.

---

## 9. Test and Validation Results

Use:

| Command | Working Directory | Result | Relevant Output | Interpretation |
|---|---|---|---|---|

Then include:

- Commands not run
- Reasons not run
- Environmental limitations
- Untested high-risk paths
- Suspected pre-existing failures
- Failures likely caused by current code
- Remaining uncertainty

---

## 10. Test and Validation Gaps

For each gap include:

- Component or workflow
- Missing validation type
- Failure behavior not covered
- Risk
- Recommended test
- Priority

Separate test gaps from confirmed implementation defects.

---

## 11. Coverage Report

Use:

| Component or Path | Coverage Level | Review Method | RepoWise Used | Source Verified | Limitations |
|---|---|---|---|---|---|

Allowed coverage levels:

- Reviewed in depth
- Interface and dependency review
- Execution validated
- Sampled
- Generated or vendored
- Excluded
- Not reviewed
- Blocked

Do not claim full coverage if any material area remains unreviewed.

---

## 12. Recommended Corrections

Group recommendations into:

### Immediate

Confirmed Critical or High risks requiring action before further development.

### Near term

Medium findings and high-priority validation gaps.

### Planned improvement

Low findings, documentation gaps, and architecture improvements with concrete value.

For each recommendation include:

- Related finding IDs
- Expected benefit
- Dependencies
- Risk of delay
- Suggested validation

Do not create a detailed implementation plan yet.

---

## 13. Proposed Specification Recovery Process

Recommend how a human should validate the as-built specification.

Include:

1. Review each major behavior
2. Mark it as intended, accidental but acceptable, defective, obsolete, or unknown
3. Resolve material unknowns
4. Convert approved behaviors into a target-state specification
5. Add explicit acceptance criteria
6. Define security, data, migration, deployment, rollback, and observability requirements
7. Approve the target-state specification before implementation planning

Do not represent the recovered as-built document as an approved product specification.

---

## 14. Proposed Implementation-Planning Process

After findings and target behavior are approved, recommend:

1. Create or update the target-state specification
2. Map accepted findings to requirements
3. Use a planning skill to create small testable tasks
4. Include exact files, interfaces, tests, commands, and commits
5. Address Critical and High risks before unrelated features
6. Use an isolated branch or worktree
7. Review each task independently
8. Perform a final cross-model review

Do not generate the full implementation plan as part of this review.

---

## 15. Unverified Areas

List:

- Code not inspected
- Tests not run
- Environments not available
- External systems not tested
- RepoWise gaps
- Stale-index concerns
- Missing historical information
- Missing product requirements
- Missing operational knowledge
- Any reason the review cannot claim full confidence

---

## 16. Final Recommendation

Choose one:

- Continue normal development
- Continue after minor corrections
- Pause and address high-priority findings
- Stop and correct critical implementation risks
- Stop pending required human decisions
- Insufficient evidence for a reliable recommendation

Explain the choice using specific evidence.

State the first three actions that should occur next.

---

# Final Session Response

After creating all three review files, provide a concise response containing:

- Files created
- Repository revision reviewed
- RepoWise freshness status
- Commands executed
- Tests and validation performed
- Number of findings by severity
- Most important unknowns
- Coverage limitations
- Final recommendation
- Confirmation that no application or infrastructure files were modified

Do not paste the entire report into the terminal response.

---

# Review Behavior

Do not modify application code.

Do not continue feature development.

Do not generate an implementation plan before the target-state specification is approved.

Do not praise the codebase merely because it is organized or tests pass.

Do not assume unconventional code is defective.

Do not assume existing code defines intended requirements.

Do not turn undocumented behavior into product policy.

Do not manufacture findings to make the review appear thorough.

Do not suppress findings because remediation would be inconvenient.

Do not propose a broad rewrite when a focused correction resolves the verified risk.

Do not claim complete coverage when material areas remain unreviewed.

If no material defects are found, state that explicitly and explain:

- What was inspected
- What was executed
- What remains unknown
- What remains unverified
- Why the evidence supports continuing

RepoWise should improve discovery, prioritization, architecture understanding, dependency analysis, and historical context.

RepoWise must not replace verification against the live repository.
