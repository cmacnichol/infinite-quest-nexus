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
  alt Valid raster response
    P-->>I: Base64 PNG, JPEG, or WebP
    I->>DB: Store asset reference and success
  else Failure or incompatible output
    P-->>I: Error or rejected output
    I->>DB: Record retryable or failed image status
  end
  Note over DB: Story acceptance never changes
```

The image role has its own endpoint, key, model inventory, defaults, health, attempts, and campaign settings. It does not inherit the story text profile.

Only validated fiction and a fiction-only prompt cross the boundary. Rolls, private reasoning, hidden trackers, raw responses, rejected narration, and provider credentials do not.

Generated files are content-addressed and independently retryable. Nexus accepts base64 PNG, JPEG, or WebP and rejects untrusted URL or SVG output for this pipeline.

Related decision: [ADR 0008](../architecture/0008-independent-illustration-pipeline.md).
