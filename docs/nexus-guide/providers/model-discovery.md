# Discover provider models

Open or refresh the model picker in a provider profile. Nexus queries the selected provider adapter and presents compatible advertised models and, where supplied, loaded or active status and context length.

Model inventories are role- and endpoint-specific. An identifier found on a text endpoint is not proof that the image or embedding endpoint supports it. Turn Intent uses text-capable discovery, but its inventory and credential still belong to its own profile.

For LM Studio native text, Nexus pins requests to the advertised loaded instance. For generic compatible providers, model metadata may omit context length; the profile then allows a configured context value.

For Sogni illustration profiles, Nexus queries Sogni's media catalog at `/api/v1/models/list` and keeps records whose `media` value is `image`. Do not use Sogni's OpenAI-compatible `/v1/models` route for this picker: that route is the account's LLM catalog. The media inventory is still a convenience, not a generation-capability guarantee. If it omits the desired image model, enter the exact model ID manually. Disable **Attempt model discovery** when the endpoint does not provide a useful inventory; generation can still use a manually configured model.

For OpenRouter illustration profiles, Nexus uses the dedicated image-model inventory and excludes entries that explicitly advertise a non-image output modality. Endpoint pricing is shown as image pricing with its reported billing unit and remains distinct from text-model input/output token pricing.

After choosing a model, save the provider and explicitly select it on the applicable campaign configuration.

For the Intent role, select **Make system default** instead of assigning the profile to a campaign. A lone Intent profile remains inactive until explicitly made default. Small models are appropriate when they reliably return the required structured classification.
