import { createServer } from "node:http";

let calls = 0;
let failCharacterResponses = 0;
const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/fail-next-character") {
    failCharacterResponses = 2;
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "deterministic-authoring" }] }));
    return;
  }
  if (request.method === "GET" && request.url === "/counts") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ calls }));
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    calls += 1;
    const text = JSON.parse(body).messages?.map((message) => message.content ?? "").join("\n") ?? "";
    const id = /char-\d+-[\w-]+/u.exec(text)?.[0];

    const content = id && failCharacterResponses-- > 0
      ? JSON.stringify({ wrong: true })
      : id
      ? JSON.stringify({ id, name: id.replace(/^char-\d+-/u, "").split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" "), character_text: "A dependable explorer.", profile: { story: { role: "Guide", background: "Maps careful roads.", personality: "Measured.", motivations: "Protect travelers.", goals: "Reach the observatory.", fearsAndConflicts: "The road shifts.", keyRelationships: "Trusts companions.", narrativeHooks: "Carries a map.", voiceAndMannerisms: "Speaks precisely.", otherGuidance: "" } }, rpg_statistics: [], default_triggers: [] })
      : JSON.stringify({ title: "Compose proof", genre: "Fantasy", tone: "Hopeful", premise: "A measured world.", backgroundStory: "Roads remember.", firstAction: "Follow the road.", story_rules: "Promises matter.", character_seeds: [
        { id: "seed-1", name: "First explorer", role: "Guide", concept: "A measured traveler.", narrative_hook: "Carries a map." },
        { id: "seed-2", name: "Second explorer", role: "Guide", concept: "A measured traveler.", narrative_hook: "Carries a map." },
        { id: "seed-3", name: "Third explorer", role: "Guide", concept: "A measured traveler.", narrative_hook: "Carries a map." }
      ], rpg_statistics: [], default_triggers: [], event_triggers: [] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `response-${calls}`, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
});
server.listen(9090, "0.0.0.0");
