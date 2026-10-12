import { bootstrapStoryPlayer, createStoryPlayerComposition } from "./composition.js";
import { startStoryPlayer } from "./story.js";

export { resolveResumeCampaign } from "@infinite-quest/client-core";
export type { ResumeCampaign } from "@infinite-quest/client-core";

bootstrapStoryPlayer(createStoryPlayerComposition, startStoryPlayer);
