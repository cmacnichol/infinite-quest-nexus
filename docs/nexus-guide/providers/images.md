# Configure an image provider

Create a separate provider profile with the **Illustrations** role.

1. Enter its independent base URL and API key.
2. Discover or enter an image-capable model.
3. Save and enable the profile.
4. Select a campaign and expand **Campaign illustrations**.
5. Select **Generate an optional illustration after each accepted turn**.
6. Choose the image profile, model, size, aspect ratio, quality, format, and attempts.
7. Select **Save illustration settings**.

OpenRouter uses its dedicated image API; generic profiles use a compatible image-generation endpoint. Nexus accepts validated base64 PNG, JPEG, or WebP output. Image URLs and SVG output are not accepted as stored generated assets.

Image jobs receive a fiction-only prompt after story acceptance. Failure never reruns or rejects the story turn.
