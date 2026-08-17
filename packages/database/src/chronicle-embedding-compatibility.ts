import { CHRONICLE_EMBEDDING_PROTOCOL_VERSION } from "../../domain/src/chronicle-memory-helpers.js";

function embeddingIdentitySql(
  prefix: "" | "chunk.",
  providerProfileExpression: string,
  modelExpression: string,
  fingerprintExpression: string,
): string {
  return `${prefix}embedding_status='embedded' AND ${prefix}embedding IS NOT NULL
    AND ${prefix}embedding_provider_profile_id=${providerProfileExpression}
    AND ${prefix}embedding_model=${modelExpression}
    AND ${prefix}embedding_protocol_version='${CHRONICLE_EMBEDDING_PROTOCOL_VERSION}'
    AND ${prefix}embedding_provider_fingerprint=${fingerprintExpression}
    AND ${prefix}embedding_content_hash=${prefix}content_hash`;
}

function compatibleEmbeddingSql(
  prefix: "" | "chunk.",
  providerProfileExpression: string,
  modelExpression: string,
  dimensionsExpression: string,
  fingerprintExpression: string,
): string {
  return `${embeddingIdentitySql(prefix, providerProfileExpression, modelExpression, fingerprintExpression)}
    AND ${prefix}embedding_dimensions=${dimensionsExpression}`;
}

// Fixed internal SQL fragments keep health coverage aligned with production semantic eligibility.
export const CHRONICLE_RANK_COMPATIBLE_EMBEDDING_SQL = compatibleEmbeddingSql(
  "", "$6", "$7", "$8", "$9"
);

export const CHRONICLE_READINESS_EMBEDDING_IDENTITY_SQL = embeddingIdentitySql(
  "chunk.", "$4", "$5", "$7"
);

export const CHRONICLE_READINESS_COMPATIBLE_EMBEDDING_SQL = compatibleEmbeddingSql(
  "chunk.", "$4", "$5", "(SELECT expected_dimensions FROM compatible_dimension)", "$7"
);

export const CHRONICLE_HEALTH_EMBEDDING_IDENTITY_SQL = embeddingIdentitySql(
  "chunk.", "$5", "$6", "$8"
);

export const CHRONICLE_HEALTH_COMPATIBLE_EMBEDDING_SQL = compatibleEmbeddingSql(
  "chunk.", "$5", "$6", "(SELECT expected_dimensions FROM compatible_dimension)", "$8"
);
