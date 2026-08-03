import { generationRequestSchema } from "@infinite-quest/contracts";
import { createCampaignStore, selectIsGenerationInFlight } from "../../../../../packages/client-core/src/index.js";
import type { Immutable, Store } from "../../../../../packages/client-core/src/index.js";

export const parsed = generationRequestSchema.safeParse({});

const readOnlyStore: Store<{ createdAt: Date }> = {
  get: () => ({ createdAt: new Date() }),
  subscribe: () => () => undefined
};

export const immutableDate: Immutable<Date> = readOnlyStore.get().createdAt;
export const campaignStore = createCampaignStore();
export const campaignGenerationInFlight = selectIsGenerationInFlight(campaignStore.store.get());

// @ts-expect-error Generic mutability remains internal to client-core.
export type InternalWritableStore = import("../../../../../packages/client-core/src/index.js").WritableStore<number>;
