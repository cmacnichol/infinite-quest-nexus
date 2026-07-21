# Configure a story text provider

1. Select **Providers** and **New provider profile**.
2. Enter a **Profile name**.
3. Choose LM Studio native, OpenRouter, Manifest, or OpenAI-compatible.
4. Select the **Story text** role.
5. Enter the **Base URL** and role-specific API key where required.
6. Discover and choose the **Default model**.
7. Review **Context window**, **Maximum output**, **Temperature**, streaming, and advanced timeout settings.
8. Enable the profile and optionally make it the role default.
9. Select **Save provider**.

The advertised loaded-model context length is used when available. A provider profile is user-owned and its key is encrypted before database persistence. The API never returns the stored key.

Changing a campaign's text profile affects its next request, which still bootstraps from authoritative campaign state.
