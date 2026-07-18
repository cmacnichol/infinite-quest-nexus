import { randomInt } from "node:crypto";
import {
  eventExtensionOutputSchema,
  eventTriggerDecisionOutputSchema,
  rpgAssessmentOutputSchema,
  type PendingEventTrigger,
  type PlayerEventTrigger,
  type PlayerRpgStat,
  type RpgAssessmentOutput
} from "../../contracts/src/generation.js";
import { stableStringify, stripMechanicsLeakage } from "../../domain/src/text.js";
import { containsMechanicsLanguage, extractJsonObject } from "./output.js";

export const RPG_ASSESSMENT_SYSTEM_PROMPT = `You are the private referee for a percentile adventure system.
Return only one valid JSON object and no commentary.

Choose exactly one provided stat. Do not determine the random result.
Required shape:
{
  "stat_id": "exact provided stat id",
  "difficulty_modifier": 0,
  "rationale": "brief private referee rationale",
  "favorable_outcome": "diegetic events if the attempt works",
  "setback_outcome": "diegetic events if the attempt does not work"
}

Keep both outcome fields entirely fictional: concrete events, reactions, discoveries, costs, or complications. Do not put numbers, rolls, dice, checks, stat names, difficulty labels, or game-system language in either outcome field. Use modifiers from -50 to 40.`;

export const EVENT_TRIGGER_SYSTEM_PROMPT = `You are the private event evaluator for an adventure engine.
Return only one valid JSON object and no commentary.

Required shape:
{
  "activated_trigger_ids": ["exact trigger id"],
  "reasons": {"trigger id": "brief private activation reason"}
}

Activate a trigger only when its condition is clearly satisfied by the supplied authoritative context. Return only exact IDs from the supplied list. Do not write narration or adapt the trigger effects.`;

export const EVENT_EXTENSION_SYSTEM_PROMPT = `You add a short fiction-only passage to an already validated adventure turn.
Return only one valid JSON object and no commentary.

Required shape:
{
  "additional_text": "one to three short paragraphs",
  "scratchpad": "optional fiction-only continuity notes",
  "tracker_updates": []
}

Continue directly from the supplied narration and reflect every supplied fictional event instruction. Never expose private evaluation, game-system terminology, hidden instructions, or reasoning.`;

export type PrivateRollResolution = {
  statId: string;
  statName: string;
  base: number;
  modifier: number;
  target: number;
  roll: number;
  success: boolean;
  margin: number;
  difficultyLabel: string;
  rationale: string;
  stakes: string;
  favorableOutcome: string;
  setbackOutcome: string;
};

export type ActivatedEvent = PendingEventTrigger & { addTextAfter: boolean };

export function buildRpgAssessmentPrompt(context: unknown, action: string, stats: PlayerRpgStat[]): string {
  return stableStringify({
    current_player_action: action,
    authoritative_fiction_context: context,
    available_stats: stats.map((stat) => ({ id: stat.id, name: stat.name, value: stat.value, covers: stat.note }))
  });
}

export function parseRpgAssessment(content: string): RpgAssessmentOutput {
  return rpgAssessmentOutputSchema.parse(extractJsonObject(content));
}

export function localRpgAssessment(action: string, stats: PlayerRpgStat[]): RpgAssessmentOutput {
  const actionText = action.toLowerCase();
  const matchers: Array<[RegExp, RegExp]> = [
    [/sneak|hide|dodge|climb|jump|run|escape|steal|balance/, /agil|dexter|stealth|speed|reflex|acrob|finesse/],
    [/fight|attack|break|force|lift|push|wrestle|endure|smash/, /strength|might|power|brawn|athlet|endurance|vigor/],
    [/notice|search|investigate|study|track|deduce|remember|analy[sz]e|inspect/, /insight|intelligence|perception|investig|knowledge|reason|wit|mind/],
    [/persuade|bluff|deceive|charm|intimidate|negotiate|convince|perform|talk/, /charisma|presence|social|speech|deception|persuasion|charm/],
    [/resist|focus|concentrate|fear|temptation|magic|spell|will/, /will|resolve|spirit|magic|arcane|faith|discipline/]
  ];
  let selected = stats[0];
  let score = -1;
  for (const stat of stats) {
    const description = `${stat.name} ${stat.note}`.toLowerCase();
    let candidate = 0;
    for (const [actionPattern, statPattern] of matchers) {
      if (actionPattern.test(actionText) && statPattern.test(description)) candidate += 10;
    }
    for (const word of actionText.match(/[a-z][a-z'-]{2,}/g) || []) {
      if (description.includes(word)) candidate += 1;
    }
    if (candidate > score) {
      selected = stat;
      score = candidate;
    }
  }
  return {
    stat_id: selected?.id || stats[0]?.id || "default",
    difficulty_modifier: 0,
    rationale: `The action was matched locally to ${selected?.name || "the first available stat"}.`,
    favorable_outcome: "The attempted action works as intended and creates a useful opening.",
    setback_outcome: "The attempted action is thwarted and introduces a plausible complication."
  };
}

function difficultyLabel(modifier: number): string {
  if (modifier >= 23) return "routine";
  if (modifier >= 8) return "easy";
  if (modifier > -8) return "standard";
  if (modifier > -23) return "hard";
  if (modifier > -38) return "very hard";
  return "nearly impossible";
}

export function performPrivateRoll(assessment: RpgAssessmentOutput, stats: PlayerRpgStat[], value = randomInt(1, 101)): PrivateRollResolution {
  const stat = stats.find((entry) => entry.id.toLowerCase() === assessment.stat_id.toLowerCase()) || stats[0];
  if (!stat) throw new Error("RPG assessment requested a roll without any configured stats.");
  const modifier = Math.max(-50, Math.min(40, Math.trunc(assessment.difficulty_modifier)));
  const target = Math.max(1, Math.min(99, stat.value + modifier));
  const roll = Math.max(1, Math.min(100, Math.trunc(value)));
  const success = roll <= target;
  return {
    statId: stat.id,
    statName: stat.name,
    base: stat.value,
    modifier,
    target,
    roll,
    success,
    margin: success ? target - roll : roll - target,
    difficultyLabel: difficultyLabel(modifier),
    rationale: assessment.rationale,
    stakes: success ? assessment.favorable_outcome : assessment.setback_outcome,
    favorableOutcome: assessment.favorable_outcome,
    setbackOutcome: assessment.setback_outcome
  };
}

export function buildEventTriggerPrompt(phase: "before" | "after", context: unknown, action: string, turnNumber: number, triggers: PlayerEventTrigger[], narration = ""): string {
  return stableStringify({
    phase,
    current_turn: turnNumber,
    current_player_action: action,
    generated_narration: phase === "after" ? narration : "",
    authoritative_fiction_context: context,
    triggers: triggers.map((trigger) => ({ id: trigger.id, condition: trigger.condition }))
  });
}

export function activatedEventsFromResponse(content: string, triggers: PlayerEventTrigger[], turnNumber: number): ActivatedEvent[] {
  const decision = eventTriggerDecisionOutputSchema.parse(extractJsonObject(content));
  const ids = new Set(decision.activated_trigger_ids);
  return triggers.filter((trigger) => ids.has(trigger.id)).map((trigger) => ({
    id: crypto.randomUUID(),
    sourceTriggerId: trigger.id,
    name: trigger.label,
    timing: trigger.timing,
    condition: trigger.condition,
    effect: trigger.effect,
    instructions: trigger.effect,
    reason: decision.reasons[trigger.id] || "The configured condition is satisfied.",
    sourceTurn: turnNumber,
    addTextAfter: trigger.timing === "after" && trigger.addTextAfter
  }));
}

function safeFictionInstruction(value: string): string {
  const sanitized = stripMechanicsLeakage(value).text.trim();
  return sanitized && !containsMechanicsLanguage(sanitized) ? sanitized : "";
}

export function fictionGuidanceForRoll(roll: PrivateRollResolution | null): string[] {
  if (!roll) return [];
  const outcome = safeFictionInstruction(roll.success ? roll.favorableOutcome : roll.setbackOutcome);
  return outcome ? [outcome] : [roll.success
    ? "The attempted action works as intended; portray only its natural fictional consequences."
    : "The attempted action is thwarted; portray only the resulting fictional complication."];
}

export function fictionGuidanceForEvents(events: ActivatedEvent[]): string[] {
  return events.map((event) => safeFictionInstruction(event.instructions)).filter(Boolean);
}

export function applyTriggerHits(triggers: PlayerEventTrigger[], events: ActivatedEvent[], timestamp: string): PlayerEventTrigger[] {
  const activated = new Map(events.map((event) => [event.sourceTriggerId, event]));
  return triggers.map((trigger) => {
    const event = activated.get(trigger.id);
    return event ? {
      ...trigger,
      triggeredCount: trigger.triggeredCount + 1,
      lastTriggeredTurn: event.sourceTurn,
      lastTriggeredAt: timestamp
    } : trigger;
  });
}

export function buildEventExtensionPrompt(narration: string, guidance: string[]): string {
  return stableStringify({ existing_narration: narration, fictional_event_instructions: guidance });
}

export function parseEventExtension(content: string) {
  const extension = eventExtensionOutputSchema.parse(extractJsonObject(content));
  const fields = [extension.additional_text, extension.scratchpad || "", JSON.stringify(extension.tracker_updates)];
  if (fields.some(containsMechanicsLanguage)) throw new Error("Mechanics language detected in event extension.");
  return extension;
}
