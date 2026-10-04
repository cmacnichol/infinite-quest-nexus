export interface StoryStreamRendererOptions {
  scheduleFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
  renderSafe: (text: string) => void;
  onFollow: () => void;
}

export interface StoryStreamRenderer {
  push(text: string, epoch: number): void;
  flush(): void;
  reset(epoch: number): void;
  dispose(): void;
}

export function createStoryStreamRenderer({
  scheduleFrame,
  cancelFrame,
  renderSafe,
  onFollow
}: StoryStreamRendererOptions): StoryStreamRenderer {
  let activeEpoch: number | undefined;
  let hasActiveEpoch = false;
  let pendingText: string | undefined;
  let scheduledFrameId: number | undefined;
  let scheduledToken: number | undefined;
  let nextScheduledToken = 0;
  let epochVersion = 0;
  let disposed = false;

  const cancelScheduledFrame = () => {
    const frameId = scheduledFrameId;
    scheduledFrameId = undefined;
    scheduledToken = undefined;
    if (frameId !== undefined) cancelFrame(frameId);
  };

  const publish = (text: string, epoch: number, version: number) => {
    renderSafe(text);
    if (!disposed && activeEpoch === epoch && epochVersion === version) onFollow();
  };

  const push = (text: string, epoch: number) => {
    if (disposed) return;
    if (!hasActiveEpoch) {
      activeEpoch = epoch;
      hasActiveEpoch = true;
    }
    if (activeEpoch !== epoch) return;

    pendingText = text;
    if (scheduledToken !== undefined) return;

    nextScheduledToken += 1;
    const token = nextScheduledToken;
    const version = epochVersion;
    scheduledToken = token;
    const frameId = scheduleFrame(() => {
      if (disposed || scheduledToken !== token || activeEpoch !== epoch || epochVersion !== version) return;

      scheduledToken = undefined;
      scheduledFrameId = undefined;
      const textToRender = pendingText;
      pendingText = undefined;
      if (textToRender !== undefined) publish(textToRender, epoch, version);
    });

    if (scheduledToken === token) scheduledFrameId = frameId;
  };

  const flush = () => {
    if (disposed) return;
    const textToRender = pendingText;
    const epoch = activeEpoch;
    const version = epochVersion;
    pendingText = undefined;
    cancelScheduledFrame();
    if (textToRender !== undefined && epoch !== undefined) publish(textToRender, epoch, version);
  };

  const reset = (epoch: number) => {
    if (disposed) return;
    epochVersion += 1;
    pendingText = undefined;
    cancelScheduledFrame();
    activeEpoch = epoch;
    hasActiveEpoch = true;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    epochVersion += 1;
    pendingText = undefined;
    cancelScheduledFrame();
  };

  return { push, flush, reset, dispose };
}
