# Discover provider models

Open or refresh the model picker in a provider profile. Nexus queries the selected provider adapter and presents compatible advertised models and, where supplied, loaded or active status and context length.

Model inventories are role- and endpoint-specific. An identifier found on a text endpoint is not proof that the image or embedding endpoint supports it.

For LM Studio native text, Nexus pins requests to the advertised loaded instance. For generic compatible providers, model metadata may omit context length; the profile then allows a configured context value.

After choosing a model, save the provider and explicitly select it on the applicable campaign configuration.
