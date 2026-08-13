export type GenerationChanged = Readonly<{
  jobId: string;
  version: string;
}>;

export interface GenerationEventSubscription extends AsyncIterable<GenerationChanged> {
  close(): Promise<void>;
}

export interface GenerationEventSource {
  subscribe(
    scope: Readonly<{ ownerUserId: string; campaignId: string; jobId: string }>,
  ): Promise<GenerationEventSubscription>;
}
