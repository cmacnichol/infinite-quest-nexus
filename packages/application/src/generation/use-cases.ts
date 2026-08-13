import type {
  GenerationApplication,
  GenerationClaimRepository,
  GenerationCommandRepository,
  GenerationExecutor,
  GenerationWorkerApplication
} from "./ports.js";

export function createGenerationApplication(
  repository: GenerationCommandRepository,
): GenerationApplication {
  return {
    enqueueAppend: (scope, request) => repository.enqueueAppend(scope, request),
    enqueueReplacement: (scope, request) => repository.enqueueReplacement(scope, request),
    getJob: (scope) => repository.getJob(scope),
    getResult: (scope) => repository.getResult(scope),
    retry: (scope) => repository.retry(scope),
    cancel: (scope) => repository.cancel(scope),
    discard: (scope) => repository.discard(scope)
  };
}

export function createGenerationWorkerApplication(
  dependencies: Readonly<{
    claims: GenerationClaimRepository;
    executor: GenerationExecutor;
  }>,
): GenerationWorkerApplication {
  return {
    claimNext: (request) => dependencies.claims.claimNext(request),
    executeClaimed: (request) => dependencies.executor.execute(request)
  };
}
