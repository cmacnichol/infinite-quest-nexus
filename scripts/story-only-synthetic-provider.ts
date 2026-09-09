import { createStoryOnlySyntheticProvider } from "../tests/helpers/story-only-synthetic-provider.js";

const host = process.env.STORY_ONLY_SYNTHETIC_PROVIDER_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const provider = await createStoryOnlySyntheticProvider(8081, host);
const port = new URL(provider.baseUrl).port;
process.stdout.write(`story-only synthetic provider listening on ${port}\n`);
const close = async () => { await provider.close(); };
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
