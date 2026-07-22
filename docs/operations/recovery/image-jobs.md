# Recover image jobs

Image jobs are independent children of accepted turns. An image failure does not require story rollback or regeneration.

1. Select the campaign and inspect **Campaign illustrations**.
2. Confirm the image profile is enabled and the model is compatible.
3. Verify worker network access and shared asset writability.
4. For Sogni, inspect the durable remote-job state, last poll, generation deadline, rate-limit guidance, and account balance or entitlement in job diagnostics and worker logs. Do not manually submit a replacement while a remote job ID already exists; Nexus will resume polling it after lease recovery.
5. Review artifact validation: Nexus downloads Sogni's temporary artifacts through the restricted worker transport, rejects URLs that directly name localhost, `.local`, or private literal IP ranges by default, limits each download to 20 MB, and accepts files with valid PNG, JPEG, or WebP signatures.
6. Select **Retry illustration** for a recoverable or failed latest job.

An explicit retry is a new generation revision and therefore a new provider idempotency key. Automatic retries before the first remote ID is persisted keep the existing key. This distinction prevents routine transport recovery from intentionally duplicating work while still allowing an operator-requested retry to create a fresh image.

Do not send raw history, private mechanics, rejected narration, or text-provider credentials to the image endpoint during manual diagnosis.
