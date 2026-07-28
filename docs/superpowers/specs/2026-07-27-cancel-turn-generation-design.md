# Cancel Turn Generation Design

## Goal

Let a Story Player cancel an in-progress turn generation immediately, returning the UI to the current accepted turn without allowing partial output to mutate campaign state.

## Scope

The control is visible only while a campaign has an active turn-generation job. It cancels the active Story Engine job and any provisional streaming illustration jobs created for that job. It does not cancel illustrations for an already accepted turn.

## Design

The API exposes an owner-scoped cancellation operation for a generation job. In one database transaction it changes an active generation job to terminal `cancelled` state and cancels its provisional streaming illustration children. Cancellation preserves job records for audit and recovery, rather than deleting rows.

The generation worker treats `cancelled` as terminal. Before each lifecycle transition and before accepted-turn commit, it verifies that its leased job is still active. A model response that arrives after cancellation is discarded; it cannot append a turn, update campaign state, add Chronicle memories, or enqueue accepted-turn artwork.

The Story Player renders a Cancel generation button only when its active job is pending. Clicking it disables the control, calls the cancellation endpoint, aborts the browser’s SSE/polling connection, clears the streaming preview and pending submission, and reloads the authoritative campaign state. The player remains on the latest accepted turn.

## Error Handling

Cancellation is idempotent for an already-cancelled job. Cancelling a completed, failed, discarded, or another user’s job is rejected without changing campaign state. If the browser request fails, the UI continues monitoring the durable job rather than assuming cancellation succeeded.

## Validation

Integration tests cover queued and running cancellation, preserve accepted turn/state/Chronicle data, and cancel matching provisional streaming image jobs while preserving accepted-turn images. API route tests cover owner scoping and terminal-status rejection. Story Player tests cover button visibility, request behavior, and restoration of the current-turn display.
