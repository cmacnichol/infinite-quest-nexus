# Claude Code Review Prompt with RepoWise

> Use this prompt in a fresh Claude Code session started from the repository root.
>
> Replace every placeholder in square brackets before beginning the review.

---

## Project Inputs

- **Specification:** `[SPEC_PATH]`
- **Implementation plan:** `[PLAN_PATH]`
- **Implementation starting point:** `[BASE_BRANCH_OR_COMMIT]`
- **Current branch:** `[CURRENT_BRANCH]`
- **Current target revision:** `[CURRENT_HEAD_OR_COMMIT]`
- **Known test commands:** `[TEST_COMMANDS_OR_REFERENCE]`
- **Known build, lint, or type-check commands:** `[VALIDATION_COMMANDS_OR_REFERENCE]`
- **Relevant deployment environment:** `[DEPLOYMENT_CONTEXT]`
- **Additional constraints:** `[PROJECT_CONSTRAINTS_OR_NONE]`

---

## Role

Act as an independent senior software engineer, software architect, and adversarial implementation reviewer.

Another coding agent, Codex using the Superpowers workflow, created a specification and implementation plan and has completed approximately half of that plan.

Your job is to review:

1. The original specification
2. The complete implementation plan
3. The work completed so far
4. The remaining planned work
5. The relationship between the specification, completed implementation, tests, and future plan
6. The architectural and operational impact of the changes

Do not continue implementing the plan.

Do not modify application code, tests, configuration, dependencies, migrations, infrastructure, documentation, or generated files during this review.

This is a read-only assessment unless a harmless command necessarily creates temporary local files. If that occurs, disclose the files and remove them before completing the review.

Do not commit, push, amend, reset, rebase, merge, install dependencies, update lockfiles, launch deployments, change external resources, or modify databases.

---

# Review Principles

Use the following evidence hierarchy:

1. Live repository source and current Git state
2. Executed test, build, lint, type-check, and diagnostic results
3. Approved specification and implementation plan
4. Repository documentation and recorded architectural decisions
5. Git history
6. RepoWise generated context, summaries, scores, and inferences

RepoWise is a discovery and prioritization tool. It is not the final source of truth.

Use RepoWise to locate architecture, dependencies, change risk, related code, history, hotspots, and potentially affected components.

Use the live repository to prove or disprove every material finding.

Do not report a generated score, inferred relationship, semantic search result, or architectural summary as a defect by itself.

Be skeptical but evidence-driven.

Do not assume:

- Codex followed the plan correctly
- Plan checkboxes are accurate
- Passing tests prove the requirements
- The implementation plan is correct
- Existing behavior is necessarily intended
- RepoWise information is current
- A high risk score proves a defect
- A low risk score proves safety
- Code comments accurately describe behavior
- Existing tests represent the complete intended contract

---

# Phase 1: Establish Repository and Index State

Before reviewing the implementation, record the exact repository state.

Run safe read-only commands such as:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse [BASE_BRANCH_OR_COMMIT]
git log --oneline --decorate -n 20
git diff --stat [BASE_BRANCH_OR_COMMIT]..HEAD
git diff --name-status [BASE_BRANCH_OR_COMMIT]..HEAD
```

If there are uncommitted changes, separately inspect:

```bash
git diff
git diff --cached
```

Do not assume the current working tree is represented by `HEAD`.

Record:

- Current branch
- Current `HEAD`
- Base revision
- Whether the working tree is clean
- Whether staged or unstaged changes exist
- Exact Git range used for review
- Whether any reviewed work is uncommitted

## RepoWise availability and freshness

Confirm that the RepoWise MCP tools are available.

Use RepoWise to retrieve repository status, overview, or index metadata.

Determine, where the available tools permit:

- Repository indexed by RepoWise
- Indexed commit or revision
- Current Git `HEAD`
- Whether indexing is complete
- Whether the index is stale
- Whether files, symbols, history, or relationships were omitted
- Whether any returned context was truncated
- Whether the current working tree contains changes not represented in the index

Do not initiate a full index or update unless explicitly authorized.

If the RepoWise index does not match the repository revision being reviewed:

- Continue using RepoWise for broad discovery
- Mark the index as stale
- Treat all indexed relationships and summaries as potentially outdated
- Verify every material conclusion against live source and Git
- Do not claim complete RepoWise coverage

---

# Phase 2: Understand the Intended System

Read the complete specification and implementation plan before judging the code.

Do not review only the completed tasks or the changed files.

Summarize:

- Intended product or feature outcome
- Functional requirements
- Nonfunctional requirements
- Users, roles, and permission expectations
- Data integrity requirements
- Security requirements
- Performance expectations
- Compatibility constraints
- Explicit architectural constraints
- Deployment assumptions
- Migration expectations
- Rollback requirements
- Observability requirements
- Testing requirements
- Acceptance criteria
- Explicitly out-of-scope work

Identify:

- Ambiguous requirements
- Contradictory requirements
- Missing acceptance criteria
- Undefined failure behavior
- Undefined authorization behavior
- Undefined migration or rollback behavior
- Assumptions that require human confirmation
- Plan items that do not map to a requirement
- Requirements that do not map to a plan item

Do not silently resolve material ambiguity. Report it.

---

# Phase 3: Build a RepoWise-Assisted Architecture Map

Use RepoWise as the initial repository-intelligence layer.

Identify:

- Application entry points
- Major modules and architectural communities
- Core domain components
- Public APIs and commands
- Authentication and authorization boundaries
- Data stores and migrations
- External integrations
- Background workers and scheduled jobs
- Shared utilities and platform abstractions
- Build and deployment components
- High-centrality components
- High-churn components
- Low-health or complex components
- Likely test locations
- Known architectural decisions
- Ownership or knowledge silos, where available

Compare the RepoWise model with:

- The specification
- The implementation plan
- Repository documentation
- The live source tree
- Git history

Record meaningful disagreements.

Classify architectural intent as:

- Explicitly documented
- Supported by source code
- Supported by tests
- Supported by Git history
- RepoWise inference
- Unverified

Do not turn a RepoWise inference into a requirement without corroboration.

---

# Phase 4: Determine What Was Actually Completed

Inspect:

- Git history
- The review range
- Changed files
- Current working-tree changes
- Relevant surrounding code
- Tests
- Configuration
- Migrations
- Documentation changed as part of the plan

Do not trust plan checkboxes, progress notes, comments, commit messages, or Codex summaries without verification.

For each plan item marked complete or apparently treated as complete, classify it as:

- Fully implemented
- Partially implemented
- Implemented differently than planned
- Not implemented
- Implemented but inadequately tested
- Implemented but not integrated
- Implemented with unresolved risks
- No longer required because the design changed
- Cannot verify

Identify:

- Changes outside the plan
- Scope creep
- Undocumented design changes
- Abandoned implementation paths
- Temporary code left in place
- Plan tasks marked complete before their acceptance criteria were met
- Tests or documentation that claim behavior not present in the code

---

# Phase 5: Analyze Change Risk and Blast Radius

Determine the exact Git range containing the work performed under the plan:

```text
[BASE_BRANCH_OR_COMMIT]..HEAD
```

Also account for staged and unstaged changes separately.

Use RepoWise change-risk and component-risk capabilities where available.

Evaluate:

- Directly changed components
- Transitive dependents
- Callers and callees
- Importers and consumers
- Architectural communities affected
- High-centrality files changed
- High-churn files changed
- Low-health files changed
- Historically defect-prone areas
- Historically co-changed files omitted from the change
- Tests associated with changed components
- Missing tests
- Security signals
- Data-flow impact
- Configuration impact
- Deployment impact
- Migration impact
- Compatibility impact
- Possible rollback impact

Do not treat a risk score as a finding.

Use risk results to prioritize manual source inspection and validation.

For each materially changed file or component, use RepoWise context retrieval to inspect, where available:

- Purpose
- Symbols and interfaces
- Callers and callees
- Importers and dependents
- Architectural community
- Centrality
- Complexity or health signals
- Ownership
- Recent history
- Architectural decisions
- Related tests
- Freshness status
- Truncation or omitted context

Batch related components where practical.

Inspect the live source for:

- Every high-risk changed component
- Every high-centrality changed component
- Every changed authentication or authorization path
- Every changed persistence or migration path
- Every changed public interface
- Any RepoWise result marked stale, incomplete, ambiguous, or truncated

---

# Phase 6: Search for Related and Conflicting Paths

Use RepoWise semantic search and normal repository search to identify:

- Alternate implementations of the same behavior
- Existing utilities Codex may have duplicated
- Existing abstractions that should have been reused
- Other authorization enforcement points
- Other validation paths
- Similar error-handling patterns
- Related migrations
- Related configuration
- Related tests and fixtures
- Legacy code that conflicts with the implementation
- Dead or abandoned paths
- Feature flags
- Environment-specific behavior
- Hidden consumers of changed interfaces
- Existing compatibility shims
- Existing rollback or recovery logic

Use multiple search terms when concepts have aliases, legacy names, abbreviations, or domain-specific vocabulary.

Do not assume the first semantic result is complete.

---

# Phase 7: Review the Completed Implementation

Review the completed work for:

## Functional correctness

- Incorrect behavior
- Incomplete requirements
- Incorrect state transitions
- Missing workflows
- Broken integration between tasks
- Incorrect defaults
- Failure to preserve existing behavior
- Edge cases
- Boundary conditions
- Incorrect assumptions
- Nondeterministic behavior

## Security

- Authentication bypass
- Authorization bypass
- Missing role or ownership checks
- Insecure direct object references
- Input validation gaps
- Injection risks
- Unsafe file handling
- Secret exposure
- Sensitive logging
- Trust-boundary violations
- Unsafe defaults
- Improper error disclosure
- Denial-of-service risks
- Incorrect cryptographic use
- Dependency or supply-chain risks

## Data integrity

- Data loss
- Partial writes
- Inconsistent transactions
- Duplicate processing
- Missing idempotency
- Incorrect retries
- Unsafe migrations
- Failed rollback behavior
- Null or default assumptions
- Referential-integrity problems
- Serialization or schema mismatches

## Concurrency and asynchronous behavior

- Race conditions
- Deadlocks
- Lost updates
- Incorrect locking
- Duplicate jobs
- Ordering assumptions
- Retry storms
- Timeout handling
- Cancellation handling
- Resource cleanup

## Error handling and recovery

- Swallowed errors
- Misleading success states
- Incorrect retry behavior
- Missing compensating action
- Incomplete cleanup
- Unobservable failure
- Unbounded loops
- Missing timeout
- Unsafe fallback
- Incorrect exit codes

## Performance and resource use

- Repeated I/O
- N+1 access patterns
- Unbounded memory growth
- Expensive operations in loops
- Missing pagination
- Excessive network calls
- Poor caching behavior
- Leaked handles or connections
- Unbounded concurrency

## Compatibility and operations

- Breaking API changes
- Configuration incompatibility
- Platform-specific failure
- Dependency-version conflict
- Build or packaging issues
- Deployment-order assumptions
- Mixed-version deployment problems
- Missing migration sequencing
- Missing rollback path
- Insufficient logging or metrics
- Missing health checks
- Unclear operational recovery

## Maintainability

Only report maintainability findings that create concrete engineering risk.

Check for:

- Duplicated behavior likely to diverge
- Unclear ownership boundaries
- Excessive coupling
- Hidden side effects
- Dead code
- Temporary compatibility paths with no removal plan
- Unusually complex code in high-risk areas
- Interfaces inconsistent with the existing codebase
- Generated or copied code that cannot be safely maintained

Do not report personal formatting or style preferences.

---

# Phase 8: Review Tests and Validation

Determine whether the completed work has meaningful validation.

Check for:

- Missing unit tests
- Missing integration tests
- Missing end-to-end tests
- Missing regression tests
- Missing negative tests
- Missing authorization tests
- Missing migration tests
- Missing rollback tests
- Missing concurrency tests
- Missing boundary-condition tests
- Tests that mirror implementation details rather than requirements
- Brittle mocks
- Incorrect fixtures
- Assertions too weak to detect broken behavior
- Tests that pass despite incorrect behavior
- Tests disabled or skipped without justification
- Coverage that omits high-risk paths
- Validation commands documented but not run
- Tests run against the wrong configuration
- Environment-specific behavior not tested

Run safe, documented validation commands when practical.

Prefer existing project commands from repository documentation, package manifests, CI, or the implementation plan.

Do not install missing dependencies or alter the environment without authorization.

For every command run, record:

- Command
- Working directory
- Result
- Relevant failures
- Whether the failure appears pre-existing or introduced by the reviewed range
- Any limitation that prevents confident interpretation

Report:

- Commands successfully run
- Commands that failed
- Commands not run
- Reasons commands were not run
- Areas remaining unverified

Do not claim a test passed unless you actually ran it or have direct trustworthy output from the current revision.

---

# Phase 9: Audit the Remaining Implementation Plan

Review every unfinished plan item before implementation continues.

For each remaining step, determine whether it is:

- Still valid
- Correctly sequenced
- Detailed enough
- Compatible with completed work
- Missing dependencies
- Based on an invalid assumption
- Likely to cause rework
- Missing required tests
- Missing validation
- Missing migration work
- Missing deployment work
- Missing observability
- Missing rollback work
- Duplicative
- Obsolete
- Unsafe to begin
- Blocked on a human decision

Look for completed work that changed assumptions underlying later tasks.

Identify steps that should be:

- Added
- Removed
- Reordered
- Split
- Combined
- Rewritten
- Deferred
- Blocked pending a decision

Check whether later tasks depend on interfaces, types, configuration, migrations, or behavior that the completed implementation did not actually produce.

Use RepoWise dependency and architectural context to identify plan steps that overlook:

- Transitive consumers
- Historical co-change partners
- Central components
- Shared abstractions
- Cross-module invariants
- Operational dependencies
- Deployment sequencing

---

# Phase 10: Check End-to-End Coherence

Determine whether completing the remaining plan exactly as written would satisfy the original specification.

Look for gaps between:

- Requirements and plan
- Plan and implementation
- Implementation and tests
- Tests and acceptance criteria
- Component behavior and end-to-end behavior
- Development behavior and production behavior
- Migration design and deployment order
- Error handling and operational recovery
- Security assumptions and actual enforcement
- RepoWise architecture and live source architecture

Do not assume individually reasonable tasks will create a coherent final system.

Construct at least one end-to-end mental or executable trace for each major workflow affected by the implementation.

Where practical, trace:

- Input
- Validation
- Authorization
- Core processing
- Persistence
- External calls
- Error behavior
- Retry behavior
- User-visible result
- Logging and observability
- Cleanup or rollback

---

# Finding Standards

Only report findings supported by repository evidence, test or command output, the specification, the plan, Git history, or a clearly explained engineering risk.

Do not inflate severity.

Do not report speculative issues without describing the missing evidence.

Do not report duplicates.

Do not hide uncertainty.

For each finding, include:

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
   - Specification
   - Plan
   - Completed implementation
   - Testing
   - Security
   - Data integrity
   - Concurrency
   - Performance
   - Migration
   - Deployment
   - Observability
   - Remaining work
   - Scope
   - Architecture
   - Maintainability

5. **Location**
   - File and line range
   - Plan section
   - Specification section
   - Commit or diff reference

6. **Issue**
   - Concise description

7. **Evidence**
   - Exact code, test result, command result, requirement, plan text, or history supporting the finding

8. **Failure scenario**
   - Concrete example showing how the issue can cause incorrect behavior, security exposure, data loss, operational failure, rework, or an unmet requirement

9. **Blast radius**
   - Components, users, environments, or data potentially affected

10. **Recommended correction**
    - Smallest reasonable correction

11. **Validation**
    - Test or verification proving the correction

12. **Source classification**
    - Live source
    - Executed validation
    - Specification
    - Plan
    - Git history
    - RepoWise-assisted discovery

A finding must not rely solely on:

- RepoWise wiki content
- RepoWise summaries
- Semantic search
- Health score
- Risk score
- Inferred architecture
- Inferred architectural decision
- Unconfirmed dependency relationship

When RepoWise and the live repository disagree, the live repository takes precedence.

Record the disagreement because it may indicate:

- Stale indexing
- Misleading documentation
- Architectural drift
- Generated-context limitations
- A genuine inconsistency requiring attention

---

# Severity Guide

## Critical

Use only for issues likely to cause:

- Broad security compromise
- Irrecoverable or widespread data loss
- Remote code execution
- Catastrophic deployment failure
- System-wide outage with no practical mitigation

## High

Use for issues likely to cause:

- Authorization bypass
- Serious data corruption
- Major required functionality failure
- Unsafe migration or deployment
- Significant production outage
- High-impact regression

## Medium

Use for:

- Real defects with limited scope
- Missing validation on meaningful paths
- Recoverable operational risks
- Performance or maintainability problems with concrete impact
- Important plan gaps likely to cause rework

## Low

Use for:

- Minor correctness risks
- Narrow observability gaps
- Small maintainability risks supported by evidence
- Noncritical inconsistencies that should be addressed

Do not classify formatting preferences as findings.

---

# Required Output

Produce the final review in this exact structure.

## 1. Executive Summary

Include:

- Overall implementation status
- Approximate plan completion based on verified work
- Whether completed work is safe to build upon
- Whether the remaining plan is safe to continue as written
- Most important risks
- Most important unknowns
- Recommended immediate next action
- Final recommendation category

Choose one final recommendation:

- Continue with the current plan
- Continue after minor corrections
- Pause and revise the remaining plan
- Stop and correct completed implementation first
- Stop pending required human decisions

---

## 2. Repository and Review State

Include:

- Repository path
- Current branch
- Base revision
- Current `HEAD`
- Working-tree status
- Staged changes
- Unstaged changes
- Review range
- Commands used to establish state
- Material limitations

---

## 3. RepoWise Analysis

Include:

- RepoWise availability
- Indexed repository
- Indexed commit or revision
- Current Git `HEAD`
- Freshness status
- Index completeness
- Tools used
- Change-risk summary
- Blast-radius summary
- Important dependents
- Historical co-change partners
- Relevant architectural decisions
- High-centrality components inspected
- High-risk or low-health components inspected
- Truncated or unavailable context
- Differences between RepoWise and live source
- How RepoWise affected review priorities

Do not dump raw tool output unless needed as evidence.

---

## 4. Intended System Summary

Summarize:

- Goal
- Main workflows
- Users and roles
- Key requirements
- Nonfunctional constraints
- Acceptance criteria
- Deployment and rollback expectations
- Important ambiguities

---

## 5. Requirement and Plan Alignment

Use this table:

| Requirement | Specification Reference | Planned Work | Current Implementation | Status | Notes |
|---|---|---|---|---|---|

Allowed statuses:

- Satisfied
- Partially satisfied
- Not satisfied
- Cannot verify
- Plan gap
- Specification ambiguity

---

## 6. Verified Completed Work

For each completed plan item, report:

| Plan Item | Claimed Status | Verified Status | Evidence | Tests | Concerns |
|---|---|---|---|---|---|

Allowed verified statuses:

- Fully implemented
- Partially implemented
- Implemented differently
- Not implemented
- Inadequately tested
- Not integrated
- Cannot verify
- No longer required

---

## 7. Findings

Group findings by severity:

### Critical

### High

### Medium

### Low

Use the complete finding format defined above.

If a severity group has no findings, state `None`.

---

## 8. Test and Validation Results

Use this table:

| Command | Working Directory | Result | Relevant Output | Interpretation |
|---|---|---|---|---|

Then include:

- Commands not run
- Reason not run
- Untested high-risk paths
- Remaining uncertainty
- Suspected pre-existing failures
- Failures likely introduced by the reviewed changes

---

## 9. Test and Validation Gaps

List missing or inadequate validation separately from implementation defects.

For each gap include:

- Affected requirement or component
- Missing test type
- Failure behavior not covered
- Recommended test
- Priority

---

## 10. Remaining Plan Assessment

Use this table:

| Plan Step | Assessment | Dependencies | Risks | Recommended Change |
|---|---|---|---|---|

Allowed assessments:

- Continue unchanged
- Revise
- Reorder
- Split
- Combine
- Remove
- Add prerequisite
- Block pending decision
- Obsolete

---

## 11. Revised Execution Order

Provide the corrected high-level order for the remaining work.

Do not rewrite the complete implementation plan unless substantial restructuring is required.

Include only enough detail to make the correct order and gating conditions clear.

---

## 12. Blockers and Human Decisions

List decisions requiring human input before implementation should continue.

For each include:

- Decision
- Why it matters
- Options
- Consequence of delaying
- Recommended default, if evidence supports one

Do not invent product decisions.

---

## 13. Unverified Areas

List:

- Code not inspected
- Tests not run
- Environments not available
- External services not tested
- RepoWise gaps
- Stale index concerns
- Missing documentation
- Missing requirements
- Any reason the review cannot claim full confidence

---

## 14. Final Recommendation

Choose one:

- Continue with the current plan
- Continue after minor corrections
- Pause and revise the remaining plan
- Stop and correct completed implementation first
- Stop pending required human decisions

Explain the choice using specific evidence.

State the first three actions that should occur next.

---

# Review Behavior

Do not modify files.

Do not continue implementation.

Do not praise the implementation merely because it is organized or tests pass.

Do not repeat Codex's explanations without independent verification.

Do not assume every issue requires a broad refactor.

Prefer the smallest correction that resolves the verified risk.

Do not suppress a finding because fixing it would disrupt the plan.

Do not manufacture defects to make the review look thorough.

If no material defects are found, state that explicitly and explain:

- What was inspected
- What was executed
- What remains unverified
- Why the evidence supports continuing

At the end, provide a concise handoff section that Codex can use to revise the plan or fix accepted findings, but do not write implementation code.
