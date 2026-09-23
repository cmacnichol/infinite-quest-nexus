# Configure a story text provider

1. Open **Setup → Provider Setup** and select **New provider profile**.
2. Enter a **Profile name**.
3. Choose LM Studio native, OpenRouter, Manifest, or OpenAI-compatible.
4. Select the **Story text** role.
5. Enter the **Base URL** and role-specific API key where required.
6. Discover and choose the **Default model**.
7. Review **Context window**, **Maximum output**, **Temperature**, streaming, and advanced timeout settings.
8. Enable the profile and optionally make it the role default.
9. Select **Save provider**.

The advertised loaded-model context length is used when available. A provider profile is user-owned and its key is encrypted before database persistence. The API never returns the stored key.

## OpenRouter saved presets

Nexus supports preset response caching through `cache_enabled` (boolean) and
`cache_ttl_seconds` (an integer from 1 through 86400). These settings are frozen
with queued work and sent as OpenRouter cache headers for each selected route.
They do not replace the structured-output JSON schema. Omitted settings retain
OpenRouter's defaults; explicit `false` disables response caching.

Saved OpenRouter preset routes must use concrete model IDs that can be frozen with a queued generation. Nexus rejects OpenRouter's `~` family aliases, `openrouter/auto`, and `openrouter/free`, including surrounding whitespace. It does not reject another concrete ID merely because it contains `latest` or begins with `openrouter/`.

When an OpenRouter preset includes one of the deliberately unsupported public configuration fields `tools`, `stop`, or `transforms`, the provider response identifies that field by name. Other unknown or private configuration names remain the generic `config` diagnostic, and Nexus does not expose remote configuration values or messages.

Changing a campaign's text profile affects its next request, which still bootstraps from authoritative campaign state.

The campaign's effective Story text profile generates Action and Story Direction
turns. Story Direction uses its frozen story-only prompt snapshot and does not
make a classifier preflight request.
