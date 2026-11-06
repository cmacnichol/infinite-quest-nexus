# SillyTavern character design research

Reviewed 2026-11-06. Research for the Infinite Quest Nexus character revamp; these are recommendations, not implemented changes.

The GitHub connector reported the repository's default branch as `release`, at commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Reviewed the character endpoint, group-chat selection code, World Info code, and official documentation. This was a source/documentation review, not a running-browser evaluation or an exhaustive extension audit.

## Useful patterns

| Pattern | Verified SillyTavern behavior | Adaptation for Infinite Quest Nexus |
| --- | --- | --- |
| Simple character creation | Only a name is required. Description, personality, scenario, and dialogue examples describe the character; advanced definitions are hidden initially. Favorites support quick access. | Start with name and a short description. Offer optional AI-assisted drafting, portraits, and voice examples. Keep identity rules and advanced prompt details out of the normal editing flow. |
| Explicit prompt cost | Character fields consume context; the editor warns when permanent definitions exceed half the model's context. | Show a compact character summary and explain which details will be used for the next turn. Prefer scoped selection over sending the whole roster. |
| Player identity separate from cast | Personas hold the user's role identity and can be automatically selected through chat, character, or default bindings. | Bind the protagonist explicitly to the campaign and restore it automatically when the campaign opens. Keep the player character visually distinct from other cast members. |
| Practical group controls | Groups support member management, mute, forced replies, and several reply-order strategies. Cards can be swapped per speaker or joined. | Offer a visible scene roster, quick character details, and presence corrections. Adapt the controls to a single story narrator rather than requiring one generation per NPC. |
| Relevant lore loaded automatically | World Info activates lore through keywords or optional vector matching and supports chat, persona, and character sources, token budgets, and timed activation. | Combine aliases, current scene, relationships, and accepted history to select relevant character context. Show why each character was selected. Scope all selection to the campaign and its world version. |
| Correctable derived memory | The Summarize extension supports scheduled updates, manual editing, pause, and restoring a prior summary. | Present automatic character observations with source-turn links, correction, and undo. Rebuild derived descriptions from accepted evidence. |

Sources: [Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/), [Personas](https://docs.sillytavern.app/usage/core-concepts/personas/), [Group Chats](https://docs.sillytavern.app/usage/core-concepts/groupchats/), [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/), [Summarize](https://docs.sillytavern.app/extensions/summarize/).

## What automation actually means upstream

World Info primarily automates selecting already-authored information for a prompt. It does not establish that a character has been discovered, is present, or has changed canonical state. Its optional vector matching still respects other activation checks and budgets. World Info can trigger Quick Reply scripts by automation ID; this is an extensibility mechanism, not evidence of a built-in authoritative character extraction pipeline. The reviewed sources do not establish an automatic, evidence-validated NPC discovery system comparable to the intended Nexus workflow. [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)

Natural group order is explicitly heuristic: name-word mentions activate existing members; talkativeness adds probabilistic activation; a random member is selected if needed. This is appropriate for conversational pacing but should never determine identity, canonical presence, or state in Nexus. The implementation confirms these steps in [`activateNaturalOrder`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/group-chats.js#L1242-L1315).

The summary documentation explicitly acknowledges omissions and hallucinations. A generated summary is useful derived memory, not a replacement for accepted turns and structured campaign facts. [Summarize](https://docs.sillytavern.app/extensions/summarize/)

## Portability and boundaries

The character endpoint reads and writes Character Card V2 fields, including identity descriptions, dialogue examples, creator metadata, prompt overrides, and an embedded character book. Its import router accepts JSON and PNG character cards. This offers a concrete future interoperability target, provided Nexus maps supported fields into an explicit world-draft import preview and reports unsupported fields. [`charaFormatData`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L565-L640), [import router](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/characters.js#L1560-L1578).

Do not activate imported system prompts, post-history instructions, or scripts automatically. Do not copy global lore selection into campaign retrieval. Keep imported prose untrusted, preserve server-side ownership, and separate reusable world-version character definitions from campaign developments. These recommendations follow the [Nexus repository architecture](../architecture/repository-overview.md) and the repository's generation-integrity rules, rather than asserting equivalent guarantees in SillyTavern.

Joined cards can blur character identity; the official group documentation specifically warns about merged personalities and confused traits. Prefer separately labelled, compact entries for relevant characters. [Group Chats](https://docs.sillytavern.app/usage/core-concepts/groupchats/)

## Recommended direction

Borrow the low-friction card editor, campaign-bound player identity, roster controls, and selective context. Build Nexus automation around its existing accepted-turn workflow: detect observations, resolve stable identities with explicit ambiguity handling, validate proposed changes, record evidence, and expose only exceptions for review. Distinguish three independent states in the interface: known character, currently present character, and character included as background context. A mere mention must not collapse those distinctions.

Prioritize easier editing and a unified roster before advanced import formats or conversational multi-speaker scheduling. Automatic extraction and identity matching are Nexus design work; the reviewed SillyTavern sources provide useful interaction and retrieval patterns, not a ready-made replacement for that authority model.
