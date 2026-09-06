# Configure Sogni illustrations

Nexus offers two illustration-only Sogni adapters. Each profile has independent credentials, model selection, health, and retry state; neither inherits story-text credentials.

| Provider type | Remote work | Generation deadline | Recovery distinction |
| --- | --- | --- | --- |
| **Sogni Creative Workflow (REST)** (`sogni`) | Creative Workflow REST API | 180 seconds by default; 30–600 seconds | Caller-controlled submission idempotency |
| **Sogni Supernet SDK** (`sogni_sdk`) | SDK Projects | 600 seconds by default; 30–3,600 seconds | Provider-generated project UUID; submit-boundary crash limitation below |

The Creative Workflow instructions below apply only to `sogni`. For the SDK adapter, use [Supernet SDK setup and recovery](#supernet-sdk-setup-and-recovery).

## Create a Creative Workflow profile {#create-the-profile}

1. Obtain an API key from the [Sogni account dashboard](https://dashboard.sogni.ai/api-key).
2. In **Provider Management**, add a profile and select **Sogni Creative Workflow (REST)**. Nexus assigns the **Illustrations** role and suggests the official `https://api.sogni.ai` base URL.
3. Paste the key, then refresh the model picker or enter an image model ID manually. Nexus uses Sogni's media catalog rather than the LLM-only OpenAI model catalog.
4. Choose one or two images, dimensions, aspect ratio, PNG or JPEG output, and quality. Content filtering remains provider-default for this adapter.
5. Set the request, polling, generation-timeout, and submission-attempt limits, then save the profile. Refreshing the saved profile's model inventory performs the first authenticated connectivity check.
6. Select the profile under a campaign's **Campaign illustrations** settings.

Sogni profile defaults are copied into the campaign illustration form when the profile is selected. The campaign may then override model, size, aspect ratio, quality, output format, and attempts. Image count and polling limits remain profile-level settings. Creative Workflow does not offer a content-filter override.

## Creative Workflow defaults and limits {#defaults-and-limits}

| Setting | New-profile default | Supported range or behavior |
| --- | --- | --- |
| Images per job | 1 | 1 or 2; all valid artifacts are stored and the first is the turn's primary illustration |
| Dimensions | 1280 × 720 | 256–8192 per side, no more than 40 megapixels |
| Aspect ratio | 16:9 | `width:height` notation |
| Requested output | PNG | PNG or JPEG; Sogni WebP requests are rejected by this adapter |
| Quality | Automatic | Stored as a campaign preference; the current direct-workflow adapter does not send a generic Sogni quality argument |
| Initial / maximum poll interval | 2 / 10 seconds | 1–30 seconds; the maximum cannot be lower than the initial interval |
| Generation deadline | 180 seconds | 30–600 seconds for the complete remote workflow |
| Submission attempts | 3 | 1–5 attempts before a remote workflow ID is obtained |
| HTTP request timeout | 30 seconds | Applies separately to each workflow submit or poll request |

The generation deadline and HTTP request timeout are different controls. A request timeout limits one network call; the generation deadline limits how long Nexus will continue polling the accepted remote workflow.

## Content filtering

Nexus uses Sogni's provider-default content filtering for direct inline workflows. The published `generate_image` step schema does not accept a `safeContentFilter` argument, so Nexus does not send one or offer an override that would make workflow validation fail. This is distinct from Sogni Studio's local gallery visibility filter and does not override Sogni account eligibility or provider policy. The API contract also rejects legacy or direct requests that attempt to select an enabled or disabled override.

## Durable generation and retries

Sogni work is asynchronous. Nexus submits a durable creative workflow, persists its `workflowId`, and polls the same workflow until it completes or reaches the configured deadline. Automatic submission retries reuse the image job's idempotency key, so a lost response does not intentionally create duplicate provider work. Once a remote ID is stored, lease recovery and transient polling failures resume polling instead of submitting again. `Retry-After` guidance is honored within Nexus's retry bounds.

Selecting **Retry illustration** after a terminal failure starts a new generation revision with a new idempotency key and clears the old remote workflow association. It does not regenerate or alter the accepted story turn.

Completed artifact URLs are temporary transport references. The worker downloads them without sending the Sogni bearer credential, rejects URLs that directly name localhost, `.local`, or private literal IP ranges by default, enforces a 20 MB download limit, verifies PNG, JPEG, or WebP signatures, and stores content-addressed assets. Temporary URLs and authorization-like metadata are removed before durable provider metadata is written.

Stored images remain available in the owner-scoped Nexus image library. World cover authoring and story illustration editing can attach an existing retained asset without rerunning Sogni or copying the stored bytes.

Sogni may bill by account plan or usage; consult [current Sogni pricing](https://docs.sogni.ai/pricing/) rather than relying on a price embedded in Nexus.

## Supernet SDK setup and recovery

1. In **Provider Management**, choose **Sogni Supernet SDK** and the **Illustrations** role. Keep `https://api.sogni.ai`; this adapter rejects other origins. Supply its own API key.
2. Select the **Fast** or **Relaxed** network and refresh the model inventory. Choose a model with available workers on that network. Changing networks can change model availability.
3. Review the discovered model's size presets and supported controls. The profile supports steps, guidance, seed, sampler, scheduler, and preview count; use model-supported values instead of assuming every model accepts the same options.
4. Review billing-token selection (`auto`, `sogni`, or `spark`) and content filtering. Defaults are Fast, automatic token choice, filtering enabled, and zero previews. The SDK exposes a filter override; it does not change Nexus's fiction-only prompt boundary.
5. Save and select the profile in the campaign illustration settings. The generation deadline defaults to 600 seconds, with a 30–3,600-second range. Polling defaults to 2 seconds.

The SDK adapter reuses a deterministic application ID for the profile. Locally tracked projects provide live progress, queue position, and ETA. After a worker change, Nexus reconciles the stored project ID through `/v1/projects/{id}`; a processing-time 404 is treated as pending until the durable deadline. Once the remote ID is persisted, recovery reconciles that project instead of creating another.

The SDK creates its own project UUID and does not accept Nexus's idempotency key. A process failure after remote acceptance but before the ID is persisted can leave an untracked charge or duplicate work on retry. Creative Workflow offers stronger submission idempotency. See [ADR 0022](../../architecture/0022-separate-sogni-sdk-provider.md) for this accepted limitation; a successful local unit test does not establish paid-provider durability.

Both adapters download completed media into Nexus asset storage and exclude temporary artifact URLs from durable provider metadata.

## Creative Workflow troubleshooting {#troubleshooting}

If model discovery returns no compatible entries, confirm **Attempt model discovery** is enabled and enter the exact image model ID manually. An empty filtered inventory does not prove that the creative-workflow endpoint is unavailable.

If generation fails, check the credential, account balance or entitlement, exact model ID, active-workflow or rate limit, output format, content-filter compatibility, request timeout, and generation deadline. Correct deterministic errors before retrying; authentication, invalid-request, unsupported-format, and artifact-validation failures are not automatically resubmitted. The accepted story turn remains complete and is never regenerated by an image retry.

The Creative Workflow adapter uses bearer-authenticated creative-workflow REST requests. See the [Sogni API reference](https://docs.sogni.ai/api-reference/) for current workflow, token, rate-limit, and billing behavior.
