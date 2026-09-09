# Story-only campaigns final review

Reviewed 2026-09-09 against source base
`977d8a533e456156aec13d713afd6691ac635186` and final integrity checkpoint
`baaf021b5bda477a3bccc50facef9ecacf16e67d`.

The final independent review found no open load-bearing implementation defect.
It closed two late findings: the Story-only rollout is explicitly excluded from
generic old/new worker overlap, and explicit choice-repair retry retains the
actual recovery-request provenance. The frozen source now validates generic
recovery output before acceptance, preserves a pending checkpoint when only
choices remain invalid, sends no provider request on lease reclaim, and sends a
single choices-only request on explicit retry.

The Task 8 integrity checkpoint reports full Windows units (3,384 passed with
44 platform skips), repository/type checks, application build, and the
eight-file affected PostgreSQL aggregate (134 passed with 15 Windows filesystem
skips). Linux counterparts are recorded separately in [the Linux and aggregate
report](task-8-linux-verification.md). Task 7 browser evidence covers legacy
18/18 plus replacement Native42 and Web Awesome42 against disposable runtimes
and synthetic providers; see the linked reports and screenshots in this
directory.

This result does not certify a live provider or deployment. The 12-case live
quality corpus remains unevaluated, and operators must use the coordinated
rollout/rollback procedure in the [deployment runbook](../../runbooks/deployment.md#story-only-campaign-policy-rollout-and-rollback).
