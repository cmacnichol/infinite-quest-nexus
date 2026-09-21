import { responseInvocationKeyV2Schema } from "@infinite-quest/contracts";

/** Bounded JSONB extraction for saved response-contract status. */
export function generationResponseFormatProjection(privateColumn: string): string {
  const text = (path: string) => `${privateColumn} #>> '{${path}}'`;
  const bounded = (path: string, maximum = 256) => `CASE WHEN length(${text(path)}) BETWEEN 1 AND ${maximum} THEN ${text(path)} ELSE NULL END`;
  const boundedExpression = (expression: string, maximum = 256) => `CASE WHEN length(${expression}) BETWEEN 1 AND ${maximum} THEN ${expression} ELSE NULL END`;
  const booleanExpression = (expression: string) => `CASE WHEN ${expression} IN ('true','false') THEN (${expression})::boolean ELSE NULL END`;
  const version = (path: string) => `CASE WHEN ${text(path)} = '1' THEN to_jsonb(1) WHEN ${text(path)} = '2' THEN to_jsonb(2) WHEN ${text(path)} IS NULL THEN NULL ELSE to_jsonb('incompatible'::text) END`;
  const value = (path: string) => `${privateColumn} #> '{${path}}'`;
  const projectContract = (contract: string) => `jsonb_build_object(
        'mode', ${boundedExpression(`${contract} ->> 'mode'`, 32)},
        'operation', ${boundedExpression(`${contract} ->> 'operation'`, 32)},
        'streaming', ${booleanExpression(`${contract} ->> 'streaming'`)},
        'schemaVersion', ${boundedExpression(`${contract} ->> 'schemaVersion'`, 200)},
        'schemaHash', ${boundedExpression(`${contract} ->> 'schemaHash'`, 64)})`;
  const storyStream = value("frozenResponseContracts,contracts,story:stream");
  const storyNonstream = value("frozenResponseContracts,contracts,story:nonstream");
  const selectedStory = `COALESCE(${storyStream}, ${storyNonstream})`;
  const latest = `${privateColumn} -> 'responseContractInvocations' -> -1`;
  const latestInvocationKey = `${latest} ->> 'invocationKey'`;
  const safeLatestInvocationKey = `CASE ${latestInvocationKey} ${responseInvocationKeyV2Schema.options.map((key) => `WHEN '${key}' THEN '${key}'`).join(" ")} ELSE NULL END`;
  const latestContract = `(${value("frozenResponseContracts,contracts")}) -> (${safeLatestInvocationKey})`;
  const projectedFrozenContracts = `CASE
      WHEN ${text("frozenResponseContracts,version")} = '2' AND ${safeLatestInvocationKey} IS NOT NULL THEN CASE WHEN ${latestContract} IS NULL THEN NULL ELSE jsonb_build_object(
        'version', ${version("frozenResponseContracts,version")},
        'contracts', jsonb_build_object(${safeLatestInvocationKey}, ${projectContract(latestContract)})) END
      WHEN ${selectedStory} IS NULL THEN NULL ELSE jsonb_build_object(
        'version', ${version("frozenResponseContracts,version")},
        'contracts', jsonb_build_object(
          'story:stream', CASE WHEN ${storyStream} IS NULL THEN NULL ELSE ${projectContract(storyStream)} END,
          'story:nonstream', CASE WHEN ${storyNonstream} IS NULL THEN NULL ELSE ${projectContract(storyNonstream)} END)) END`;
  return `jsonb_build_object(
    'queuedResponsePolicy', CASE WHEN ${value("queuedResponsePolicy")} IS NULL THEN NULL ELSE jsonb_build_object(
      'version', ${version("queuedResponsePolicy,version")}, 'policy', ${bounded("queuedResponsePolicy,policy", 16)}, 'model', ${bounded("queuedResponsePolicy,model")},
      'admission', jsonb_build_object('mode', ${bounded("queuedResponsePolicy,admission,mode", 32)}, 'basis', ${bounded("queuedResponsePolicy,admission,basis", 32)}),
      'authority', jsonb_build_object('kind', ${bounded("queuedResponsePolicy,authority,kind", 32)}, 'model', ${bounded("queuedResponsePolicy,authority,model", 500)},
        'selection', jsonb_build_object('kind', ${bounded("queuedResponsePolicy,authority,selection,kind", 32)}, 'slug', ${bounded("queuedResponsePolicy,authority,selection,slug", 200)}))
    ) END,
    'frozenResponseContracts', ${projectedFrozenContracts},
    'responseContractInvocations', CASE WHEN jsonb_typeof(${privateColumn} -> 'responseContractInvocations') = 'array' AND jsonb_typeof(${latest}) = 'object' THEN jsonb_build_array(jsonb_build_object(
      'version', CASE WHEN ${latest} ->> 'version' = '1' THEN to_jsonb(1) WHEN ${latest} ->> 'version' = '2' THEN to_jsonb(2) WHEN ${latest} ->> 'version' IS NULL THEN NULL ELSE to_jsonb('incompatible'::text) END, 'invocationKey', CASE WHEN length(${latest} ->> 'invocationKey') BETWEEN 1 AND 64 THEN ${latest} ->> 'invocationKey' ELSE NULL END, 'request', jsonb_build_object('mode', CASE WHEN length(${latest} #>> '{request,mode}') BETWEEN 1 AND 32 THEN ${latest} #>> '{request,mode}' ELSE NULL END, 'operation', CASE WHEN length(${latest} #>> '{request,operation}') BETWEEN 1 AND 32 THEN ${latest} #>> '{request,operation}' ELSE NULL END, 'streaming', CASE WHEN ${latest} #>> '{request,streaming}' IN ('true','false') THEN (${latest} #>> '{request,streaming}')::boolean ELSE NULL END, 'requestedModel', CASE WHEN length(${latest} #>> '{request,requestedModel}') BETWEEN 1 AND 256 THEN ${latest} #>> '{request,requestedModel}' ELSE NULL END, 'schemaVersion', CASE WHEN length(${latest} #>> '{request,schemaVersion}') BETWEEN 1 AND 200 THEN ${latest} #>> '{request,schemaVersion}' ELSE NULL END, 'schemaHash', CASE WHEN length(${latest} #>> '{request,schemaHash}') BETWEEN 1 AND 64 THEN ${latest} #>> '{request,schemaHash}' ELSE NULL END),
      'response', CASE WHEN jsonb_typeof(${latest} -> 'response') = 'object' THEN jsonb_build_object('returnedModel', CASE WHEN length(${latest} #>> '{response,returnedModel}') BETWEEN 1 AND 500 THEN ${latest} #>> '{response,returnedModel}' ELSE NULL END, 'returnedProviderRoute', CASE WHEN length(${latest} #>> '{response,returnedProviderRoute}') BETWEEN 1 AND 500 THEN ${latest} #>> '{response,returnedProviderRoute}' ELSE NULL END, 'diagnosticCode', CASE WHEN length(${latest} #>> '{response,diagnosticCode}') BETWEEN 1 AND 64 THEN ${latest} #>> '{response,diagnosticCode}' ELSE NULL END) ELSE NULL END)) ELSE '[]'::jsonb END
  )`;
}
