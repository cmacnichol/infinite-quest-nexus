# 0025. Streaming Illustration Pipeline

## Status

Accepted

## Context

The story engine generation process has historically awaited completion of narrative text before finalizing turns and subsequently initiating any necessary illustration generation. This sequential process resulted in long delays before users could view illustrations corresponding to their narrative, hindering the immersive experience.

As generation times for large prompts increased and we introduced segmented story tracking, we identified an opportunity to begin the illustration process synchronously while the text generation model is streaming output. By generating images in parallel with text stream consumption, we can significantly reduce the perceived latency between text completion and illustration display.

Additionally, to ensure robust parsing of AI refinement for illustrations, we needed the prompt to strictly return structured data (JSON). And finally, we needed a way for the frontend to filter provisional, streaming image jobs so that expired, orphaned, or completed jobs from prior generation attempts wouldn't be mistakenly surfaced on the currently active stream.

## Decision

We will implement a streaming illustration pipeline with the following characteristics:

1.  **Provisional Segments**: As narrative text streams from the story engine, the backend will incrementally chunk the text. When a segment boundary is reached, the backend will immediately create provisional `turn_illustration_sets` and `turn_illustration_segments` along with an associated `image_jobs` record targeting `streaming_illustration`. 
2.  **Streaming Lifecycle**: The provisional tables allow for a relaxed database constraint where `turn_id` may be `NULL`. These provisional elements are tied together using the `generation_job_id`. Once the text streaming fully completes and the actual turn is saved to the database, these provisional segments and images are officially promoted by assigning the newly created `turn_id`.
3.  **Frontend Streaming State Tracking**: The client application will actively track the current `generationJobId` during its text consumption. The client will routinely poll the `/image-jobs` API and render dynamic UI placeholders within the `streamingPreviewCard`. It will strictly filter the returned provisional image jobs using `generationJobId` to ensure only illustrations relevant to the active stream are shown.
4.  **JSON Enforced Prompts**: The prompt template (`illustration_refinement`) relies on structured output. We update this prompt template to mandate explicit JSON extraction to prevent parser fallbacks due to conversational chatter from the model.

## Consequences

*   **Improved Perceived Performance**: Generating images as text streams masks the generation time of the image provider, offering a nearly instantaneous visual payload when the turn text completes.
*   **Decoupled Turn State**: Image jobs can now be initiated, processed, and potentially fail or timeout *before* the parent turn is even committed to the database. This requires robust cleanup and promotion logic to handle orphaned provisional sets.
*   **More Complex Client State**: The frontend must now track and reconcile provisional (`generation_job_id`) illustration states alongside finalized (`turn_id`) illustration states.
