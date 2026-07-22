# Configure an image provider

Create a separate provider profile with the **Illustrations** role.

1. Enter its independent base URL and API key.
2. Discover or enter an image-capable model.
3. Save and enable the profile.
4. Select a campaign and expand **Campaign illustrations**.
5. Select **Generate an optional illustration after each accepted turn**.
6. Choose the image profile, model, size, aspect ratio, quality, format, and attempts.
7. Select **Save illustration settings**.

OpenRouter uses its dedicated image API; Sogni uses its asynchronous job adapter; generic profiles use a compatible image-generation endpoint. Nexus validates PNG, JPEG, or WebP before storing it. Temporary Sogni artifact URLs are downloaded by the worker and are not retained as the generated asset; generic image URLs and SVG output are rejected.

OpenRouter image discovery uses its dedicated image-model inventory and removes entries that explicitly advertise a non-image output modality. When OpenRouter exposes endpoint pricing, the picker labels it as image pricing by its billing unit, such as image or megapixel. This is intentionally separate from text-model input and output token pricing.

Image jobs receive a fiction-only prompt after story acceptance. Failure never reruns or rejects the story turn.

Image provider defaults and campaign settings have different scopes. Campaigns own the selected profile, model, requested size, aspect ratio, quality, format, and attempt count. A Sogni profile additionally owns images per job, sensitive-content filter mode, polling intervals, and the remote generation deadline. Selecting a Sogni profile copies its applicable defaults into the campaign form; later profile edits do not silently rewrite saved campaign settings.

For Sogni-specific profile defaults and troubleshooting, see [Configure Sogni](./sogni.md).

## Generate a world cover

Set an enabled image profile as the default image provider and give it a default model. In **World Management**, either select **Generate cover** when creating a world or select an existing world and use the **World cover** control on the Overview tab. Leave the prompt blank to build a fiction-only cover prompt from the world's title, genre, tone, and premise, or provide a custom fiction-only prompt.

World covers are durable image jobs, so slow and asynchronous providers remain supported. A cover is stored as a Nexus asset and does not block saving, publishing, or campaign creation. Cover charges are retained on the image job but are not added to any campaign cost total because no campaign caused the request.
