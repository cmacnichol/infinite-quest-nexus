// Compatibility surface for application consumers while the descriptor is
// contracts-owned. Keep this module free of application-local schema copies.
export {
  publicTextExecutionPlanSummary,
  textExecutionPlanPublicSummarySchema,
  textExecutionPlanSchema,
  textGenerationParametersSchema,
  textRouteCandidateSchema,
  providerRoutingPolicySchema,
  type ProviderRoutingPolicy,
  type TextExecutionPlan,
  type TextExecutionPlanPublicSummary,
  type TextGenerationParameters,
  type TextRouteCandidate
} from "@infinite-quest/contracts";
