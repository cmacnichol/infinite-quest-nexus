import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cancelSogniSdkGeneration,
  discoverSogniSdkModels,
  disposeSogniSdkSessions,
  pollSogniSdkGeneration,
  submitSogniSdkGeneration
} from "../../packages/story-engine/src/providers/illustration/sogni-sdk/index.js";
import type { TextProviderProfile } from "../../packages/story-engine/src/providers.js";

const live = process.env.SOGNI_LIVE_TEST === "1";

describe.skipIf(!live)("paid Sogni SDK durability qualification", () => {
  it("discovers, persists, restarts, reconciles, downloads, and cancels without resubmission", async () => {
    const apiKey = String(process.env.SOGNI_API_KEY || "").trim();
    expect(apiKey, "SOGNI_API_KEY is required when SOGNI_LIVE_TEST=1").not.toBe("");
    const profile: TextProviderProfile = {
      providerType: "sogni_sdk",
      baseUrl: String(process.env.SOGNI_BASE_URL || "https://api.sogni.ai"),
      model: "",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0.8,
      apiKey,
      configuration: { network: "relaxed", tokenType: "auto", contentFilter: "enabled", defaultPreviewCount: 0, pollIntervalMs: 2_000 }
    };
    const models = await discoverSogniSdkModels(profile);
    const selected = models.find((model) => model.id === process.env.SOGNI_MODEL) || models.find((model) => model.loaded) || models[0];
    expect(selected, "Sogni returned no image models").toBeTruthy();
    profile.model = selected!.id;
    const smallest = [...(selected!.imageOptions?.sizePresets || [])].sort((left, right) => left.width * left.height - right.width * right.height)[0];
    profile.configuration = {
      ...profile.configuration,
      defaultSizePreset: smallest?.id || "custom",
      defaultWidth: smallest?.width || 512,
      defaultHeight: smallest?.height || 512,
      defaultSteps: selected!.imageOptions?.steps?.min
    };

    const submitted = await submitSogniSdkGeneration(profile, {
      prompt: "A small blue crystal resting on a plain stone table, fictional fantasy concept art.",
      size: `${smallest?.width || 512}x${smallest?.height || 512}`,
      aspectRatio: smallest?.ratio || "1:1",
      quality: "low",
      outputFormat: "png",
      imageCount: 1,
      idempotencyKey: `live-${Date.now()}`
    });
    const progress = [submitted.progress ?? 0];
    const scratch = await mkdtemp(join(tmpdir(), "infinitequest-sogni-live-"));
    const durableRecord = join(scratch, "remote-project.json");
    await writeFile(durableRecord, JSON.stringify({ remoteJobId: submitted.remoteJobId }), "utf8");
    expect(await readFile(durableRecord, "utf8")).not.toContain(apiKey);

    disposeSogniSdkSessions();
    let terminal = await pollSogniSdkGeneration(profile, submitted.remoteJobId);
    for (let poll = 0; terminal.status === "pending" && poll < 450; poll += 1) {
      if (terminal.progress !== undefined) progress.push(terminal.progress);
      await new Promise((resolve) => setTimeout(resolve, terminal.status === "pending" ? terminal.pollAfterMs || 2_000 : 0));
      terminal = await pollSogniSdkGeneration(profile, submitted.remoteJobId);
    }
    expect(terminal.status).toBe("completed");
    if (terminal.status !== "completed") return;
    expect(terminal.artifacts).toHaveLength(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true);
    const artifact = terminal.artifacts[0]!;
    expect(artifact.source).toBe("url");
    if (artifact.source === "url") {
      const response = await fetch(artifact.url);
      expect(response.ok).toBe(true);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(100);
      await writeFile(join(scratch, "artifact.bin"), bytes);
    }

    const cancellation = await submitSogniSdkGeneration(profile, {
      prompt: "A plain gray cube on a white background.", size: `${smallest?.width || 512}x${smallest?.height || 512}`,
      aspectRatio: smallest?.ratio || "1:1", quality: "low", outputFormat: "png", imageCount: 1,
      idempotencyKey: `live-cancel-${Date.now()}`
    });
    await cancelSogniSdkGeneration(profile, cancellation.remoteJobId);
    disposeSogniSdkSessions();
    let cancelled = await pollSogniSdkGeneration(profile, cancellation.remoteJobId);
    for (let poll = 0; cancelled.status === "pending" && poll < 60; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      cancelled = await pollSogniSdkGeneration(profile, cancellation.remoteJobId);
    }
    expect(cancelled.status).toBe("failed");
  }, 1_200_000);
});
