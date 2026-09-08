import assert from "node:assert/strict";
import test from "node:test";
import { closedCurrentSourceStage, safeClosedStage } from "./source-smoke-safe-diagnostics.mjs";
import * as diagnostics from "./source-smoke-safe-diagnostics.mjs";

test("ignores a closed historical generation while its replacement is running", () => {
  const job = {
    id: "safe-job-id",
    status: "running",
    stages: [
      {
        key: "source:chunk:source-chunk:0",
        generation: 1,
        status: "recoverable",
        attemptCount: 2,
        failure: { code: "invalid_authoring_output", retryable: true, issues: [] }
      },
      { key: "source:chunk:source-chunk:0", generation: 2, status: "running", attemptCount: 1 }
    ]
  };

  assert.equal(closedCurrentSourceStage(job), undefined);
});

test("does not retain an arbitrary source stage key", () => {
  const job = {
    id: "safe-job-id",
    status: "recoverable",
    stages: [{
      key: "source:private-value",
      generation: 1,
      status: "recoverable",
      attemptCount: 1,
      failure: { code: "invalid_authoring_output", retryable: true, issues: [] }
    }]
  };

  assert.equal(closedCurrentSourceStage(job), undefined);
});

test("normalizes an opaque source chunk key before emitting diagnostics", () => {
  const stage = {
    key: "source:chunk:source-chunk:9:split-live-retry",
    generation: 1,
    status: "recoverable",
    attemptCount: 2,
    failure: { code: "invalid_authoring_output", retryable: true, issues: [] }
  };
  const job = { id: "safe-job-id", status: "recoverable", stages: [stage] };

  assert.equal(closedCurrentSourceStage(job), stage);
  assert.equal(safeClosedStage(job, stage).stage.key, "source:chunk");
  assert.equal(JSON.stringify(safeClosedStage(job, stage)).includes("split-live-retry"), false);
});

test("recognizes a current recoverable synthesis stage from the real API shape", () => {
  const stage = {
    key: "source:synthesis",
    generation: 1,
    status: "recoverable",
    attemptCount: 1,
    failure: {
      code: "invalid_authoring_output",
      retryable: true,
      issues: [{ code: "custom", path: "fields.1.value", message: "Generated source-world field is not supported by the reviewed facts." }]
    }
  };
  const job = {
    id: "safe-job-id",
    status: "recoverable",
    source: { extractionComplete: true, acceptedFactIds: ["reviewed-fact"], selectedCharacterFactIds: ["reviewed-fact"] },
    stages: [stage]
  };

  assert.equal(closedCurrentSourceStage(job), stage);
  assert.deepEqual(safeClosedStage(job, stage).stage, {
    key: "source:synthesis",
    generation: 1,
    status: "recoverable",
    attemptCount: 1,
    failureCode: "invalid_authoring_output",
    retryable: true,
    issues: [{ code: "custom", path: "fields.1.value", category: "source_world_unsupported_fact" }]
  });
});

test("normalizes a closed dynamic character stage key before emitting diagnostics", () => {
  const stage = {
    key: "source:character:source-fact:7d4a67f1-864a-4ccb-9d58-1cf1a2f04b62:4e772f2cd2e165c47c67c55da97432eced97a00508f54e6fdb94b3c1b01c468b",
    generation: 2,
    status: "failed",
    attemptCount: 3,
    failure: { code: "authoring_retry_exhausted", retryable: false, issues: [] }
  };
  const job = { id: "safe-job-id", status: "failed", stages: [stage] };

  assert.equal(closedCurrentSourceStage(job), stage);
  assert.equal(safeClosedStage(job, stage).stage.key, "source:character");
  assert.equal(JSON.stringify(safeClosedStage(job, stage)).includes("source-fact"), false);
});

test("summarizes a successful real API job without identifiers or result content", () => {
  const summary = diagnostics.safeJobSummary({
    id: "9d5cbe21-0942-44ea-9670-f65f8b669c4c",
    status: "awaiting_review",
    canApply: true,
    result: { generatedWorld: { title: "Private generated title" } },
    stages: [{ key: "source:character:source-fact:7d4a67f1-864a-4ccb-9d58-1cf1a2f04b62:4e772f2cd2e165c47c67c55da97432eced97a00508f54e6fdb94b3c1b01c468b", generation: 1, status: "validated" }]
  });

  assert.deepEqual(summary, {
    jobId: true,
    stageCount: 1,
    status: "awaiting_review",
    canApply: true,
    hasResult: true
  });
  assert.equal(JSON.stringify(summary).includes("9d5cbe21"), false);
  assert.equal(JSON.stringify(summary).includes("Private generated title"), false);
});

test("classifies an actual projected source issue without retaining its message", () => {
  const stage = {
    key: "source:chunk:source-chunk:0",
    generation: 2,
    status: "recoverable",
    attemptCount: 1,
    failure: {
      code: "invalid_authoring_output",
      retryable: true,
      issues: [{
        code: "custom",
        path: "facts.0.citations.0.quote",
        message: "Generated source citation quote does not match the selected source text."
      }]
    }
  };

  assert.deepEqual(safeClosedStage({ id: "safe-job-id", status: "recoverable", stages: [stage] }, stage), {
    boundary: "source-stage-closed",
    job: { jobId: true, stageCount: 1, status: "recoverable" },
    stage: {
      key: "source:chunk",
      generation: 2,
      status: "recoverable",
      attemptCount: 1,
      failureCode: "invalid_authoring_output",
      retryable: true,
      issues: [{ code: "custom", path: "facts.0.citations.0.quote", category: "source_quote" }]
    }
  });
});

test("classifies the exact ambiguous-quote projection without retaining its message", () => {
  const stage = {
    key: "source:chunk:source-chunk:0",
    generation: 1,
    status: "recoverable",
    attemptCount: 2,
    failure: {
      code: "invalid_authoring_output",
      retryable: true,
      issues: [{
        code: "custom",
        path: "facts.1.citations.0.quote",
        message: "Generated source citation quote must identify one unique selected passage."
      }]
    }
  };

  assert.deepEqual(safeClosedStage({ id: "safe-job-id", status: "recoverable", stages: [stage] }, stage).stage.issues, [
    { code: "custom", path: "facts.1.citations.0.quote", category: "source_quote_ambiguous" }
  ]);
});

test("uses only a closed safe job status while waiting for the rendered recovery state", () => {
  assert.equal(diagnostics.renderedClosedJobStatus({ status: "recoverable" }), "is recoverable · idle.");
  assert.equal(diagnostics.renderedClosedJobStatus({ status: "failed" }), "is failed · idle.");
  assert.equal(diagnostics.renderedClosedJobStatus({ status: "running" }), null);
});
