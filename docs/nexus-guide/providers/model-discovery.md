# Discover provider models

Open or refresh the model picker in a provider profile. Nexus queries the selected provider adapter and presents compatible advertised models and, where supplied, loaded or active status and context length.

Model inventories are role- and endpoint-specific. An identifier found on a text endpoint is not proof that the image or embedding endpoint supports it. Turn Intent uses text-capable discovery, but its inventory and credential still belong to its own profile.

For LM Studio native text, Nexus pins requests to the advertised loaded instance. For generic compatible providers, model metadata may omit context length; the profile then allows a configured context value.

For Sogni illustration profiles, Nexus queries the configured endpoint's `/v1/models` inventory and keeps entries that explicitly advertise image generation or whose identifiers look image-capable. This is a convenience filter, not a capability guarantee. If the current inventory omits an image model or does not expose recognizable capability metadata, enter the exact model ID manually. Disable **Attempt model discovery** when the endpoint does not provide a useful inventory; generation can still use a manually configured model.

After choosing a model, save the provider and explicitly select it on the applicable campaign configuration.

For the Intent role, select **Make system default** instead of assigning the profile to a campaign. A lone Intent profile remains inactive until explicitly made default. Small models are appropriate when they reliably return the required structured classification.
