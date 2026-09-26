import type { GenerationPolicySnapshot } from "../../contracts/src/campaign-generation-policy.js";
import { appendStoryOutputEncodingContract, composeStoryMemorySystemPrompt, composeStoryPromptSystemPrompt } from "../../contracts/src/story-prompt.js";
import { composeStoryOnlySystemPrompt } from "./story-only-prompt.js";

/** The single composition used by execution and preview. */
export function composeEffectiveStorySystemPrompt(input: Readonly<{
  writerPrompt: string;
  storyOnlyPolicy: Extract<GenerationPolicySnapshot, { playMode: "story_only" }> | null;
  storyMemoryPromptProtocol: string | null;
  storyPromptContractProtocol?: string;
  encodingContract: string;
}>): string {
  const composed = input.storyOnlyPolicy
    ? composeStoryOnlySystemPrompt(input.writerPrompt, input.storyOnlyPolicy, input.storyMemoryPromptProtocol !== null,
      input.storyMemoryPromptProtocol ?? undefined, input.storyPromptContractProtocol)
    : input.storyMemoryPromptProtocol !== null
      ? composeStoryMemorySystemPrompt(input.writerPrompt, "", input.storyMemoryPromptProtocol)
      : input.storyPromptContractProtocol
        ? composeStoryPromptSystemPrompt(input.writerPrompt, input.storyPromptContractProtocol)
        : input.writerPrompt;
  return appendStoryOutputEncodingContract(composed, input.encodingContract);
}
