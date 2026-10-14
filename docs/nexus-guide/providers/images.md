# Configure an image provider

Create a separate provider profile with the **Illustrations** role.

1. Enter its independent base URL and API key.
2. Discover or enter an image-capable model.
3. Save and enable the profile.
4. Select a campaign and expand **Campaign illustrations**.
5. Select **Generate an optional illustration after each accepted turn**.
6. Choose the image profile, model, size, aspect ratio, quality, format, and attempts.
7. Select **Save illustration settings**.

OpenRouter uses its dedicated image API; Sogni offers separate Creative Workflow and Supernet SDK asynchronous adapters; generic profiles use a compatible image-generation endpoint. Nexus validates PNG, JPEG, or WebP before storing it. Temporary Sogni artifact URLs are downloaded by the worker and are not retained as the generated asset; generic image URLs and SVG output are rejected.

OpenRouter image discovery uses its dedicated image-model inventory and removes entries that explicitly advertise a non-image output modality. When OpenRouter exposes endpoint pricing, the picker labels it as image pricing by its billing unit, such as image or megapixel. This is intentionally separate from text-model input and output token pricing.

Accepted-turn image jobs receive a fiction-only prompt after acceptance. Provisional streaming jobs can begin earlier; see the [illustration lifecycle and open validation-boundary conflict](../../concepts/illustration-pipeline.md#provisional-streaming-path-and-open-contract-conflict). Image failure never reruns or rejects the story turn.

When a campaign uses **AI-refined visual prompt** mode, **Campaign illustrations** provides a modal editor containing the complete default visual-translation prompt. Each campaign starts with that default and may save its own prompt. **Restore default** replaces the editor contents with the application default.

For each refinement call, Nexus sends the selected fiction excerpt plus a compact fiction-only context: world premise, genre and tone, the campaign art style, the selected character description, the end of the previous turn, and the end of the preceding segment of the same turn. Segments refined while a turn is still streaming receive the same context. The context is capped and labeled as continuity reference so the model illustrates the selected excerpt rather than an earlier event. Mechanics, private reasoning, and unsafe scratchpad content remain excluded.

### Style and exclusions

The **Style** group appears when the campaign generates images.

- **Art style** is added to every generated image prompt, after the scene and before the character reference. Use it to keep one medium and palette across the campaign, for example "ink and watercolor storybook, muted palette". When it is set, the refinement prompt does not choose its own style. Leave it empty to let each prompt choose.
- **Exclude from images** lists things images should not contain. Nexus sends it as a negative prompt to providers that accept one, such as Sogni. Other endpoints, including OpenAI-compatible and OpenRouter profiles, receive it as a closing "Avoid: …" sentence. New campaigns start with text, captions, watermarks, logos, interface elements, speech bubbles, and borders excluded.

Exclusions are kept out of the main prompt because diffusion models tend to draw what a prompt names, even after "do not". Composed prompts are limited to 3,400 characters. When a scene is longer, Nexus shortens the scene text and keeps the art style and character reference.

Image provider defaults and campaign settings have different scopes. Campaigns own the selected profile, model, requested size, aspect ratio, quality, format, and attempt count. Sogni profiles additionally own image count, polling intervals, and the remote generation deadline. Only the Supernet SDK adapter exposes a content-filter override; Creative Workflow uses provider-default filtering. Selecting a Sogni profile copies its applicable defaults into the campaign form; later profile edits do not silently rewrite saved campaign settings.

For Sogni-specific profile defaults and troubleshooting, see [Configure Sogni](./sogni.md).

## Generate a world cover

Set an enabled image profile as the default image provider and give it a default model. In **World Management**, either select **Generate cover** when creating a world or select an existing world and use the **World cover** control on the Overview tab. Leave the prompt blank to build a fiction-only cover prompt from the world's title, genre, tone, and premise, or provide a custom fiction-only prompt.

World covers are durable image jobs, so slow and asynchronous providers remain supported. A cover is stored as a Nexus asset and does not block saving, publishing, or campaign creation. Cover charges are retained on the image job but are not added to any campaign cost total because no campaign caused the request.
