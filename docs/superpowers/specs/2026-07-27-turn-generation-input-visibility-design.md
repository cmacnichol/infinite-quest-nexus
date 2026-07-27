# Turn Generation Input Visibility Design

## Goal

Keep prior-turn controls out of view while a replacement or next turn is being generated, and restore them if generation does not reach acceptance.

## Design

The Story Player treats the choices, Prompt-mode controls, and free-action input as one input panel. The existing transactional generation display owns its visibility: it hides the panel when generation begins, restores the prior panel after a failed, cancelled, or discarded job, and leaves the panel hidden until the accepted turn has been reloaded and its new choices have been rendered.

## Scope

Only `apps/web/public/story.js` and its focused Story Player UI regression test change. No API, schema, persistence, or styling changes are needed.

## Validation

The regression test must prove the generation lifecycle calls the input-panel renderer to hide controls at start and to restore them on failure and accepted completion. The targeted Vitest file then verifies the behavior.
