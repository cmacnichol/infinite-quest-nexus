# Illustration pipeline

Illustrations are optional post-acceptance work with an independent provider boundary.

```mermaid
sequenceDiagram
  participant W as Story worker
  participant DB as PostgreSQL
  participant I as Image worker
  participant P as Image endpoint
  W->>DB: Commit accepted turn and fiction-only image prompt
  DB-->>I: Claim optional image child job
  I->>P: Send sanitized prompt with image-role credentials
  alt Valid raster response or completed asynchronous job
    P-->>I: Base64 raster or temporary artifact reference
    I->>I: Download and validate PNG, JPEG, or WebP
    I->>DB: Store asset reference and success
  else Failure or incompatible output
    P-->>I: Error or rejected output
    I->>DB: Record retryable or failed image status
  end
  Note over DB: Story acceptance never changes
```

The image role has its own endpoint, key, model inventory, defaults, health, attempts, and campaign settings. It does not inherit the story text profile.

World-cover generation uses the same durable worker path with a different target: an editable world rather than an accepted turn. It always resolves the default image provider and model, stores the completed asset on the world, and never creates a campaign or changes campaign cost totals.

Only validated fiction and a fiction-only prompt cross the boundary. Rolls, private reasoning, hidden trackers, raw responses, rejected narration, and provider credentials do not.

Generated files are content-addressed and independently retryable. Sogni remote job IDs, generation revisions, deadlines, and polling state are durable so another worker can resume safely without intentionally duplicating an accepted remote workflow. Provider artifacts are downloaded under bounded network and size controls, then validated by raster signature as PNG, JPEG, or WebP; SVG and payloads masquerading as images are rejected.

Related decision: [ADR 0008](../architecture/0008-independent-illustration-pipeline.md).
