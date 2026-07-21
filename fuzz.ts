import { truncateAtBoundary } from "./packages/domain/src/text";

function original(text: string, maximumCharacters: number): string {
  const value = String(text ?? "").trim();
  if (value.length <= maximumCharacters) return value;
  const candidate = value.slice(0, Math.max(0, maximumCharacters - 1));
  const boundary = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "), candidate.lastIndexOf("\n"));
  const cut = boundary >= maximumCharacters * 0.55 ? candidate.slice(0, boundary + 1) : candidate;
  return `${cut.trimEnd()}…`;
}

for (let i = 0; i < 100000; i++) {
  const chars = ["a", " ", ".", "!", "?", "\n"];
  let s = "";
  const len = Math.floor(Math.random() * 50) + 10;
  for (let j = 0; j < len; j++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  const max = Math.floor(Math.random() * len);

  const expected = original(s, max);
  const actual = truncateAtBoundary(s, max);

  if (expected !== actual) {
    console.log("FAIL", {s, max, expected, actual});
    process.exit(1);
  }
}
console.log("PASS");
