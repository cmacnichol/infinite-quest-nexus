/**
 * Synthetic compatibility matrix for the pre-history-coverage planner.
 *
 * Each expected value is intentionally a literal captured from the current
 * planner, provider serializer, and evidence-manifest implementation.  The
 * focused test validates the context and manifest schemas before comparing
 * those values, so a hash cannot pass by exercising a fixture-only helper.
 */
export type PlannerBaselineProtocol = "legacy" | "v3" | "v4";
export type PlannerBaselinePolicy = "r1" | "r2" | "r3" | null;
export type PlannerBaselineSerializer = "direct" | "frozen-route";
export type PlannerBaselineReview = "off" | "observe" | "enforce";
export type PlannerBaselineCast = "none" | "pending" | "current";

export type PlannerBaselineExpected = Readonly<{
  writerBytes: number;
  writerHash: string;
  manifestBytes: number;
  manifestHash: string;
  producingRequestHash: string;
  reviewBytes: number | null;
  reviewHash: string | null;
  reviewPlanningTokens: number | null;
  reviewerInputLimit: number | null;
}>;

export type PlannerBaselineCase = Readonly<{
  id: string;
  protocol: PlannerBaselineProtocol;
  policy: PlannerBaselinePolicy;
  serializer: PlannerBaselineSerializer;
  reviewMode: PlannerBaselineReview;
  cast: PlannerBaselineCast;
  expected: PlannerBaselineExpected;
}>;

const golden = (
  writerBytes: number, writerHash: string, manifestBytes: number, manifestHash: string,
  reviewBytes: number | null = null, reviewHash: string | null = null, reviewerInputLimit: number | null = null,
  reviewPlanningTokens: number | null = null
): PlannerBaselineExpected => ({ writerBytes, writerHash, manifestBytes, manifestHash, producingRequestHash: writerHash, reviewBytes, reviewHash, reviewPlanningTokens, reviewerInputLimit });

const goldens: Readonly<Record<string, PlannerBaselineExpected>> = {
  "legacy/none/direct/off/none": golden(3495, "0d44b9ca3f0fef2607f74bec631a0028c7488d9a7eccc430e4a68e7f0401cad2", 5598, "0737502e207f1aff5a1bcc366eba75f99fcd26014baa6aedfc10310e95f9571d"),
  "legacy/none/frozen-route/off/none": golden(5484, "1f22a6fe7004821abd81c9c6ff8fadacecf87d9546644efba9c0068f591782d7", 5598, "5a1e2e26e96a2edadd5c6351593990b1dfaa294e43030c44ab8db91f71ddf713"),
  "v3/r1/direct/off/none": golden(4231, "10af9b5552228f26b7a53f57625eefabb9c8944270d813a694fb228cca0b5cee", 7053, "298408aefc6685f58fb2df4684d9a7ad8cbe362f71659c5295b2b626bccb0255"),
  "v3/r1/frozen-route/off/none": golden(6220, "57c5e26f1b8bddd1bad6ac044bfcb86f1ea505f5d61340ad05b08a15b889aec9", 7053, "523dd229204f8ae5afac89c74e86731afe28c903ff4a426b921c9f694f539e97"),
  "v3/r2/direct/off/none": golden(4400, "9e8de8ba6df8dd30fc5d23536476972678d5fab8635ed089f2cd9e17015ddc3b", 8514, "12f2e153ed020983ac85a311ad474c6119dd1c0edcf0be68375172bd1e535420"),
  "v3/r2/frozen-route/off/none": golden(6389, "2ffb79efa3186e2ffeb3d857eed6d8b610f2bf7e1b07756f1b036b1cf070c3bc", 8514, "6ece0029af885e898b9e282d427042fc08d8d621074752155d1ae98b4b867a69"),
  "v3/r3/direct/off/none": golden(4400, "9e8de8ba6df8dd30fc5d23536476972678d5fab8635ed089f2cd9e17015ddc3b", 8514, "12f2e153ed020983ac85a311ad474c6119dd1c0edcf0be68375172bd1e535420"),
  "v3/r3/frozen-route/off/none": golden(6389, "2ffb79efa3186e2ffeb3d857eed6d8b610f2bf7e1b07756f1b036b1cf070c3bc", 8514, "6ece0029af885e898b9e282d427042fc08d8d621074752155d1ae98b4b867a69"),
  "v3/r3/direct/observe/none": golden(4400, "9e8de8ba6df8dd30fc5d23536476972678d5fab8635ed089f2cd9e17015ddc3b", 8514, "12f2e153ed020983ac85a311ad474c6119dd1c0edcf0be68375172bd1e535420", 8699, "cce23d9f817531fb2672f9b9ab530db41999dd34670d7f95c6ea6f33617e84aa", null, 4925),
  "v3/r3/frozen-route/observe/none": golden(6389, "2ffb79efa3186e2ffeb3d857eed6d8b610f2bf7e1b07756f1b036b1cf070c3bc", 8514, "6ece0029af885e898b9e282d427042fc08d8d621074752155d1ae98b4b867a69", 8699, "77af109e86f32563d4c4d14d4f4024de70e10114179e6a987f357bb12266f308", null, 4925),
  "v3/r3/direct/enforce/none": golden(4400, "9e8de8ba6df8dd30fc5d23536476972678d5fab8635ed089f2cd9e17015ddc3b", 8514, "12f2e153ed020983ac85a311ad474c6119dd1c0edcf0be68375172bd1e535420", 8699, "cce23d9f817531fb2672f9b9ab530db41999dd34670d7f95c6ea6f33617e84aa", 16000, 4925),
  "v3/r3/frozen-route/enforce/none": golden(6389, "2ffb79efa3186e2ffeb3d857eed6d8b610f2bf7e1b07756f1b036b1cf070c3bc", 8514, "6ece0029af885e898b9e282d427042fc08d8d621074752155d1ae98b4b867a69", 8699, "77af109e86f32563d4c4d14d4f4024de70e10114179e6a987f357bb12266f308", 16000, 4925),
  "v4/r2/direct/off/pending": golden(5219, "3c1fd9b7ed1e997901a11a90082053c6bf79f454d52c432de5c8e9d0ee9278e7", 11866, "3b9d197622b5e2cb577061a26a3348dc0d9d986ec52d84f7f58176c2f4d9e5cb"),
  "v4/r2/frozen-route/off/pending": golden(7208, "d9b174c73e813f428a61d42c388f2f11c13911484ad937acd97a9e14320d5e65", 11866, "567310254f067a8a61f377b1102e38f473d17c3604ef506f4660e7d7b8370d3f"),
  "v4/r2/direct/off/current": golden(5141, "15db7ba9f5acecb66dceff741e634b3dab76675678892f82cfaa6f72e9b585eb", 11788, "f0459dce6f9024e09d07c8d0211604b0fa4b04365d62a224e8184e9200148410"),
  "v4/r2/frozen-route/off/current": golden(7130, "9e1fba8160c37a4e5d973369280f51215deacb0cefde00d597979e943ce9b0aa", 11788, "9b21cecb9a1585b82b1a14f4d8233b0432b2c3b4fea1f4e5f11f7d7c688063c2"),
  "v4/r3/direct/off/pending": golden(5219, "3c1fd9b7ed1e997901a11a90082053c6bf79f454d52c432de5c8e9d0ee9278e7", 11866, "3b9d197622b5e2cb577061a26a3348dc0d9d986ec52d84f7f58176c2f4d9e5cb"),
  "v4/r3/frozen-route/off/pending": golden(7208, "d9b174c73e813f428a61d42c388f2f11c13911484ad937acd97a9e14320d5e65", 11866, "567310254f067a8a61f377b1102e38f473d17c3604ef506f4660e7d7b8370d3f"),
  "v4/r3/direct/observe/pending": golden(5219, "3c1fd9b7ed1e997901a11a90082053c6bf79f454d52c432de5c8e9d0ee9278e7", 11866, "3b9d197622b5e2cb577061a26a3348dc0d9d986ec52d84f7f58176c2f4d9e5cb", 11704, "a7a5fe6f1e244dafda57505ef60c3eee10383ef5134c1d3d37fc9670828af02d", null, 5927),
  "v4/r3/frozen-route/observe/pending": golden(7208, "d9b174c73e813f428a61d42c388f2f11c13911484ad937acd97a9e14320d5e65", 11866, "567310254f067a8a61f377b1102e38f473d17c3604ef506f4660e7d7b8370d3f", 11704, "42edd07146475815c3104015b2f98ef75806a108407e9ba57de2518d8a5df300", null, 5927),
  "v4/r3/direct/enforce/pending": golden(5219, "3c1fd9b7ed1e997901a11a90082053c6bf79f454d52c432de5c8e9d0ee9278e7", 11866, "3b9d197622b5e2cb577061a26a3348dc0d9d986ec52d84f7f58176c2f4d9e5cb", 11704, "a7a5fe6f1e244dafda57505ef60c3eee10383ef5134c1d3d37fc9670828af02d", 16000, 5927),
  "v4/r3/frozen-route/enforce/pending": golden(7208, "d9b174c73e813f428a61d42c388f2f11c13911484ad937acd97a9e14320d5e65", 11866, "567310254f067a8a61f377b1102e38f473d17c3604ef506f4660e7d7b8370d3f", 11704, "42edd07146475815c3104015b2f98ef75806a108407e9ba57de2518d8a5df300", 16000, 5927),
  "v4/r3/direct/off/current": golden(5141, "15db7ba9f5acecb66dceff741e634b3dab76675678892f82cfaa6f72e9b585eb", 11788, "f0459dce6f9024e09d07c8d0211604b0fa4b04365d62a224e8184e9200148410"),
  "v4/r3/frozen-route/off/current": golden(7130, "9e1fba8160c37a4e5d973369280f51215deacb0cefde00d597979e943ce9b0aa", 11788, "9b21cecb9a1585b82b1a14f4d8233b0432b2c3b4fea1f4e5f11f7d7c688063c2"),
  "v4/r3/direct/observe/current": golden(5141, "15db7ba9f5acecb66dceff741e634b3dab76675678892f82cfaa6f72e9b585eb", 11788, "f0459dce6f9024e09d07c8d0211604b0fa4b04365d62a224e8184e9200148410", 11626, "8c276d232bdc58a9bb88e25bc7400db5c3d6a53350b40b43ae23ff830138e8ed", null, 5901),
  "v4/r3/frozen-route/observe/current": golden(7130, "9e1fba8160c37a4e5d973369280f51215deacb0cefde00d597979e943ce9b0aa", 11788, "9b21cecb9a1585b82b1a14f4d8233b0432b2c3b4fea1f4e5f11f7d7c688063c2", 11626, "709adacb7a1b32d81a842850737dbbb4de6642f07763362be75a6652a83724cb", null, 5901),
  "v4/r3/direct/enforce/current": golden(5141, "15db7ba9f5acecb66dceff741e634b3dab76675678892f82cfaa6f72e9b585eb", 11788, "f0459dce6f9024e09d07c8d0211604b0fa4b04365d62a224e8184e9200148410", 11626, "8c276d232bdc58a9bb88e25bc7400db5c3d6a53350b40b43ae23ff830138e8ed", 16000, 5901),
  "v4/r3/frozen-route/enforce/current": golden(7130, "9e1fba8160c37a4e5d973369280f51215deacb0cefde00d597979e943ce9b0aa", 11788, "9b21cecb9a1585b82b1a14f4d8233b0432b2c3b4fea1f4e5f11f7d7c688063c2", 11626, "709adacb7a1b32d81a842850737dbbb4de6642f07763362be75a6652a83724cb", 16000, 5901)
};

const caseFor = (
  protocol: PlannerBaselineProtocol,
  policy: PlannerBaselinePolicy,
  serializer: PlannerBaselineSerializer,
  reviewMode: PlannerBaselineReview,
  cast: PlannerBaselineCast,
  _reviewerInputLimit: number | null = null
): PlannerBaselineCase => ({
  id: [protocol, policy ?? "none", serializer, reviewMode, cast].join("/"),
  protocol,
  policy,
  serializer,
  reviewMode,
  cast,
  expected: goldens[[protocol, policy ?? "none", serializer, reviewMode, cast].join("/")]!
});

export const plannerBaselineCases: readonly PlannerBaselineCase[] = [
  caseFor("legacy", null, "direct", "off", "none"),
  caseFor("legacy", null, "frozen-route", "off", "none"),
  ...(["r1", "r2"] as const).flatMap((policy) =>
    (["direct", "frozen-route"] as const).map((serializer) => caseFor("v3", policy, serializer, "off", "none"))),
  ...(["off", "observe", "enforce"] as const).flatMap((reviewMode) =>
    (["direct", "frozen-route"] as const).map((serializer) => caseFor("v3", "r3", serializer, reviewMode, "none",
      reviewMode === "enforce" ? 16_000 : null))),
  ...(["pending", "current"] as const).flatMap((cast) =>
    (["direct", "frozen-route"] as const).map((serializer) => caseFor("v4", "r2", serializer, "off", cast))),
  ...(["pending", "current"] as const).flatMap((cast) =>
    (["off", "observe", "enforce"] as const).flatMap((reviewMode) =>
      (["direct", "frozen-route"] as const).map((serializer) => caseFor("v4", "r3", serializer, reviewMode, cast,
        reviewMode === "enforce" ? 16_000 : null))))
];
