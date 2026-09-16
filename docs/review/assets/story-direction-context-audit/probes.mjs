// Read-only synthetic audit probes. Run from the repository root:
// node --import tsx docs/review/assets/story-direction-context-audit/probes.mjs
import assert from 'node:assert/strict';
import { loadPostgresChronicleGenerationAuthorityContext } from '../../../../packages/database/src/chronicle-generation-context.ts';
import { materializeGenerationContinuity } from '../../../../packages/database/src/campaign-continuity-repository.ts';
import { planChronicleQueries } from '../../../../packages/domain/src/chronicle-query-plan.ts';
import { parseStoryOnlyOutput } from '../../../../packages/story-engine/src/story-only-output.ts';
import { buildStoryUserPrompt } from '../../../../packages/story-engine/src/prompt.ts';
import { generationStagePolicy } from '../../../../packages/domain/src/campaign-generation-policy.ts';
import { logger } from '../../../../packages/logger/src/index.ts';

const snapshot = { continuitySummary: 'The sealed gate is ahead.', scratchpad: '', openThreads: [], canonicalFacts: [] };
const worldContent = {
  world: { title: 'Synthetic audit world', rules: 'Keep established geography.' },
  playableCharacters: [{ id: 'hero', name: 'ImmutableHeroCanary' }],
  entities: [{ id: 'gate', name: 'EntityCanary', description: 'The gate opens only at moonrise.' }],
  relationships: [{ from: 'hero', to: 'gate', description: 'RelationshipCanary' }]
};
const statements = [];
const database = { async query(sql) {
  statements.push(sql);
  if (sql.includes('FOR UPDATE OF campaign, state')) return { rows: [{ active_turn_number: 0, world_version_id: 'world-version', revision: 1 }] };
  if (sql.includes('campaign_state_edits')) return { rows: [] };
  if (sql.includes('generation_context_state')) return { rows: [{
    world_content: worldContent, selected_character_id: 'hero', initial_state_snapshot: snapshot,
    scratchpad_private: '', character_profile: { name: 'EditedHeroCanary', profile: { identity: { background: 'CharacterBackgroundCanary' } } },
    character_snapshot: worldContent.playableCharacters[0]
  }] };
  throw new Error(`Unexpected query: ${sql}`);
} };
const context = await loadPostgresChronicleGenerationAuthorityContext(database, {
  ownerUserId: 'owner', campaignId: 'campaign', worldVersionId: 'world-version',
  operationKind: 'append', expectedTurnNumber: 1, query: 'Describe the gate.'
});
const prompt = buildStoryUserPrompt({
  authoritativeRules: context.authority.rules, worldCanon: context.authority.worldCanon,
  selectedCharacterId: context.authority.selectedCharacterId,
  currentContinuity: context.authority.currentContinuity,
  currentScene: context.authority.latestTurn, chronicle: []
}, 'Describe the gate.', false, [], undefined, 'scene');
const omitted = ['ImmutableHeroCanary', 'EntityCanary', 'RelationshipCanary', 'EditedHeroCanary', 'CharacterBackgroundCanary'];
for (const canary of omitted) assert.equal(prompt.includes(canary), false);
assert.equal(prompt.includes('Keep established geography.'), true);

const structured = materializeGenerationContinuity({ ...snapshot,
  canonicalFacts: [], canonicalFactUpdates: [{ content: 'StructuredFactCanary', supersedesFactIds: [] }]
});
assert.deepEqual(structured.canonicalFacts, []);
assert.equal(JSON.stringify(structured).includes('StructuredFactCanary'), false);
const plain = materializeGenerationContinuity({ ...snapshot, canonicalFacts: ['PlainFactCanary'] });
assert.equal(plain.canonicalFacts[0].id, null);

const direction = 'The travelers watch the quiet river and describe the reflection. '.repeat(65)
  + 'Finally return to the ObsidianPromiseCanary and honor the agreement.';
const queries = planChronicleQueries({ action: direction,
  sceneHints: [{ ordinal: 9, content: 'SceneHintCanary appears beside the gate.' }],
  openThreadHints: [{ ordinal: 9, content: 'ThreadHintCanary remains unresolved.' }]
});
assert(queries.length > 0);
assert(queries.every((query) => !/ObsidianPromiseCanary|SceneHintCanary|ThreadHintCanary/.test(query.query)));

const unrelatedOutput = {
  narration: 'You sit beside the river and watch the clouds.',
  choices: ['Follow the river.', 'Rest beneath the willow.', 'Speak to the ferryman.', 'Return to the road.'],
  custom_action_suggestion: 'Describe the distant hillside.', scratchpad: '', tracker_updates: [], image_prompt: '',
  continuity_summary: '', canonical_facts: [], canonical_fact_updates: [], superseded_facts: [], open_threads: []
};
assert.equal(parseStoryOnlyOutput(JSON.stringify(unrelatedOutput)).ok, true);
assert.equal(generationStagePolicy('story_only').allowSceneCoverage, false);

logger.info({
  event: 'story_direction_context_audit_probes_complete',
  authorityProjection: { worldRulesPresent: true, omittedCanaries: omitted, mockedDatabase: true },
  canonicalProjection: { structuredOnlyFactAbsentFromProtectedContinuity: true, plainFactProtectedId: plain.canonicalFacts[0].id },
  longDirectionRetrieval: { directionCharacters: direction.length, variants: queries.map(({ kind, query }) => ({ kind, characters: query.length })), lateBeatAndHintsAbsent: true },
  semanticValidationBoundary: { unrelatedNarrationWithEmptyContinuityAcceptedByParser: true, storyOnlySceneCoverageEnabled: false },
  limitations: 'Synthetic function probes, not a real PostgreSQL or live-provider run. They demonstrate current behavior, not approved behavior.'
});
