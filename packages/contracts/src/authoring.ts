import { z } from "zod";

export const authoringStageSchema = z.enum(["world", "character", "organizer"]);
export const authoringIssueSchema = z.object({
  path: z.string().max(500),
  code: z.string().max(100),
  message: z.string().max(500)
}).strict();
export const authoringFailureCodeSchema = z.enum([
  "invalid_authoring_output",
  "authoring_output_limit",
  "authoring_provider_unavailable",
  "authoring_provider_timeout",
  "authoring_provider_rejected",
  "authoring_context_exceeded"
]);
export const authoringFailureSchema = z.object({
  code: authoringFailureCodeSchema,
  stage: authoringStageSchema,
  retryable: z.boolean(),
  issues: z.array(authoringIssueSchema).max(20),
  correlationId: z.string().trim().min(1).max(200).optional()
}).strict();

export type AuthoringStage = z.infer<typeof authoringStageSchema>;
export type AuthoringIssue = z.infer<typeof authoringIssueSchema>;
export type AuthoringFailure = z.infer<typeof authoringFailureSchema>;
