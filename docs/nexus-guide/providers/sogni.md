# Configure Sogni illustrations

Sogni is an illustration-only provider in Nexus. It has an independent endpoint, encrypted bearer credential, model choice, health state, and retry lifecycle; it never inherits the story-text provider's endpoint or key.

## Create the profile

1. Obtain an API key from the [Sogni account dashboard](https://dashboard.sogni.ai/api-key).
2. In **Provider Management**, add a profile and select **Sogni AI**. Nexus assigns the **Illustrations** role and suggests the official `https://api.sogni.ai` base URL.
3. Paste the key, then refresh the model picker or enter an image model ID manually. Nexus uses Sogni's media catalog rather than the LLM-only OpenAI model catalog.
4. Choose one or two images, dimensions, aspect ratio, PNG or JPEG output, quality, and filter mode.
5. Set the request, polling, generation-timeout, and submission-attempt limits, then save the profile. Refreshing the saved profile's model inventory performs the first authenticated connectivity check.
6. Select the profile under a campaign's **Campaign illustrations** settings.

Sogni profile defaults are copied into the campaign illustration form when the profile is selected. The campaign may then override model, size, aspect ratio, quality, output format, and attempts. Image count, sensitive-content filtering, and polling limits remain profile-level settings.

## Defaults and limits

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

## Troubleshooting

If model discovery returns no compatible entries, confirm **Attempt model discovery** is enabled and enter the exact image model ID manually. An empty filtered inventory does not prove that the creative-workflow endpoint is unavailable.

If generation fails, check the credential, account balance or entitlement, exact model ID, active-workflow or rate limit, output format, content-filter compatibility, request timeout, and generation deadline. Correct deterministic errors before retrying; authentication, invalid-request, unsupported-format, and artifact-validation failures are not automatically resubmitted. The accepted story turn remains complete and is never regenerated by an image retry.

Nexus uses Sogni's documented bearer-authenticated creative-workflow REST API. See the [Sogni API reference](https://docs.sogni.ai/api-reference/) for current workflow, token, rate-limit, and billing behavior.
