# Scene context and mechanics: pending review

Status: open documentation and design review, recorded 2026-09-05.

The [repository instructions](https://github.com/cmacnichol/infinite-quest-nexus/blob/main/AGENTS.md) include trackers in current-scene context while requiring mechanics to remain outside narration, story memory, embeddings, and fiction-only prompt history. Review the meaning and routing of trackers before revising either requirement.

## Review scope

- Identify which trackers represent diegetic facts and which contain mechanical values.
- Trace tracker data through mechanics assessment, narrative prompt assembly, Chronicle memory, and illustration prompts.
- Define the typed boundary and sanitization needed to pass only appropriate diegetic outcomes into fiction paths.
- Check existing contracts and regression coverage before recommending behavior changes.
- Record the resulting decision in the relevant context documentation or an ADR and update the root pointer if appropriate.

Until this review is resolved, preserve the existing mechanics-separation and validation safeguards. This note authorizes no runtime behavior change and does not claim that current tracker routing has been verified.

See [Domain docs](../agents/domain.md) for decision placement and the [test matrix](../workflows/testing.md) for applicable verification.
