import type {
  IllustrationApplicationDependencies,
  IllustrationConfigRepository,
  IllustrationGenerationTransactionPort,
  IllustrationJobRepository,
  IllustrationResolutionRepository,
  IllustrationSegmentRepository,
  IllustrationStreamingRepository
} from "../../application/src/index.js";
import type { DatabasePool } from "./pool.js";

export type IllustrationRepositoryFactories = Readonly<{
  createConfigRepository(pool: DatabasePool): IllustrationConfigRepository;
  createJobRepository(pool: DatabasePool): IllustrationJobRepository;
  createSegmentRepository(pool: DatabasePool): IllustrationSegmentRepository;
  createResolutionRepository(pool: DatabasePool): IllustrationResolutionRepository;
  createStreamingRepository(pool: DatabasePool): IllustrationStreamingRepository;
  createGenerationTransactionPort(pool: DatabasePool): IllustrationGenerationTransactionPort;
}>;

/**
 * Binds the illustration application's split repositories to one PostgreSQL
 * pool without collapsing the domain back into a generic repository.
 */
export function createPostgresIllustrationRepositories(
  pool: DatabasePool,
  factories: IllustrationRepositoryFactories,
): IllustrationApplicationDependencies {
  return {
    config: factories.createConfigRepository(pool),
    jobs: factories.createJobRepository(pool),
    segments: factories.createSegmentRepository(pool),
    resolutions: factories.createResolutionRepository(pool),
    streaming: factories.createStreamingRepository(pool),
    transaction: factories.createGenerationTransactionPort(pool)
  };
}
