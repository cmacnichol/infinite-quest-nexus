# Configure turn intent classification

Turn intent classification supports the player's **Auto** input mode. It decides whether submitted text is an **Action** or **Scene direction** before the story turn is queued. It does not rewrite the input, resolve mechanics, generate narration, validate scene coverage, or replace the campaign's Story text provider.

## Default routing

For an Auto submission, Nexus uses:

1. The enabled **Turn intent classification** profile explicitly marked as the system default.
2. Otherwise, the campaign's effective **Story text** profile.
3. If classification cannot complete, the campaign's configured mode fallback.

Creating a single Intent profile does not activate it automatically. This role deliberately has no “default because it is the only profile” behavior. Select **Make system default** when the profile should classify Auto submissions. Disabling or deleting that profile returns future classification to the campaign Story text provider.

Story narration always uses the campaign's Story text provider, even when a separate Intent profile is configured.

## Configure a small classifier model

1. Open **Setup → Provider Setup** and select **New provider profile**.
2. Choose **Turn intent classification** as the role.
3. Configure a text-capable provider endpoint and its own credential.
4. Discover and select a model that reliably follows structured-output instructions.
5. Enable the profile, save it, and select **Make system default**.

A small, fast model is usually sufficient. Good starting values are:

- Context window: **8192** tokens, or the model's advertised limit
- Maximum output: **256** tokens
- Temperature: **0**
- A short request timeout appropriate for an interactive preflight decision

Nexus applies a small deterministic output limit and temperature for classification requests without changing the profile's stored settings. Prefer reliability on the four expected classifications—`action`, `scene`, `mixed`, and `uncertain`—over creative writing quality.

## Failure behavior

If the system-default Intent profile times out, is unhealthy, or returns invalid structured output, Nexus records a safe health failure and retries classification once with the campaign Story text profile. If that also fails, the story input is not discarded: Nexus applies the campaign fallback and continues. A classification failure by itself does not make story generation fail.

Provider diagnostics may identify the role, endpoint origin, model, status class, timeout, and correlation ID. They exclude the submitted text, credentials, private reasoning, and raw model output.

## Security boundary

Intent profiles are independent, user-owned provider profiles with separately encrypted credentials. Never copy the Story text credential merely because both endpoints use the same vendor. The classifier receives only the current submitted text and the narrow classification contract; it receives no Chronicle context, private mechanics, provider keys, or authority to mutate the campaign.
