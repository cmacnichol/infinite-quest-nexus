# Public metadata refresh for the offline probe

Observed 2026-09-20 23:44:13 UTC. This is metadata evidence, not an inference result or a compatibility qualification.

The [OpenRouter endpoint catalog](https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2-exp/endpoints) identifies `deepseek/deepseek-v3.2-exp` and currently lists:

| Route tag | Context tokens | Maximum completion tokens | Input USD/token | Output USD/token |
| --- | ---: | ---: | ---: | ---: |
| siliconflow/fp8 | 163840 | 147456 | 0.00000027 | 0.00000041 |
| atlas-cloud/fp8 | 163840 | 147456 | 0.00000027 | 0.00000041 |
| novita/fp8 | 163840 | 65536 | 0.00000027 | 0.00000041 |

All three advertise `structured_outputs` and `response_format`. Advertisement does not prove compatibility with the application's exact operation schemas, stream modes, or routing constraints.

The user's target remains `@preset/nexus-nsfw`. The catalog order above is not that preset's configured priority. No authenticated preset configuration was fetched during this refresh. The [list-presets API](https://openrouter.ai/docs/api/api-reference/presets/list-presets) requires authentication; public model metadata cannot establish the selected preset version or its ordered model/provider configuration.

The [final offline plan](probe-plan.md) contains all 17 v2 operation/stream cases with an explicit hypothetical Novita candidate and a bounded maximum for that case only. The private configured preset version/order remains unavailable. Recheck prices and resolve those private inputs before any separately authorized execution. No provider inference, credentials, or private campaign data were used here.
