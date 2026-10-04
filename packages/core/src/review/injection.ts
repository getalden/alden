/** What an instruction to a reviewer starts with: "say", "approve", "ignore", "do not", "you must"… */
const ORDER = String.raw`(?:please\s+)?(?:ignore|approve|say|report|mark|treat|consider|pretend|respond|reply|output|forget|disregard|skip|do\s+not|don'?t|never|you\s+(?:must|should|will|are))\b`;

/**
 * Text written for an AI reviewer rather than a human one: attempts to steer Alden's model, the host's model, or any
 * other AI reviewing the PR. Each pattern needs the instruction and its target together, so ordinary words ("ignore
 * whitespace", "the previous step") don't match on their own.
 */
const PATTERNS: RegExp[] = [
  // "Ignore all previous instructions", "disregard the above prompt".
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|former|system)\s+(?:instructions?|prompts?|rules|directions|guidelines|context)\b/i,
  // A phrase lifted from model output, written to pass as the model's own words.
  /\bas\s+an\s+ai\s+(?:language\s+)?model\b/i,
  // Addressed to AI reviewers: "AI reviewers: say this is safe", "Note to the LLM".
  new RegExp(
    String.raw`\b(?:ai|llm|automated)\s+(?:code\s+)?(?:reviewers?|assistants?|agents?|models?)\s*[:,]\s*${ORDER}`,
    "i",
  ),
  /\b(?:note|message)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llms?|language\s+models?|claude|copilot|chatgpt|gpt|gemini)(?:\s+(?:reviewers?|assistants?|agents?))?\s*[:,]/i,
  // Addressed to a named assistant and telling it what to do. (Not "cursor" or "llm": `fetch(cursor, skip)` is code.)
  new RegExp(String.raw`\b(?:claude|copilot|chatgpt|gemini|coderabbit)\s*[:,]\s*${ORDER}`, "i"),
  // Asking for a verdict on this change, in the voice of an instruction to a reviewer.
  /\b(?:say|state|report|respond|conclude|tell\s+(?:the\s+)?(?:user|reviewer|human))\s+(?:that\s+)?(?:this|the)\s+(?:pr|pull\s+request|change|diff|code)\s+(?:is|looks)\s+(?:safe|secure|fine|correct|approved|good)\b/i,
];

/** The first stretch of `text` aimed at an AI reviewer, trimmed to a readable length, or undefined. */
export function findInjection(text: string): string | undefined {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    // Up to 20 characters before and 40 after, cut at word boundaries.
    let start = Math.max(0, match.index - 20);
    if (start > 0) start = text.slice(start, match.index).search(/\s/) + start + 1 || match.index;
    let end = Math.min(text.length, match.index + match[0].length + 40);
    if (end < text.length)
      end = text.lastIndexOf(" ", end) > match.index + match[0].length ? text.lastIndexOf(" ", end) : end;
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    const cut = snippet.length > 100 || end < text.length;
    return `${start > 0 ? "…" : ""}${snippet.slice(0, 100)}${cut ? "…" : ""}`;
  }
  return undefined;
}

/**
 * Files whose job is to instruct AI tools (CLAUDE.md, AGENTS.md, Copilot and Cursor rules). Text in them is meant
 * for an assistant, so it isn't suspicious there.
 */
export const AI_INSTRUCTION_FILE =
  /(^|\/)(?:CLAUDE|AGENTS|GEMINI)(?:\.local)?\.md$|(^|\/)\.cursorrules$|(^|\/)\.(?:claude|cursor)\/|(^|\/)\.github\/(?:copilot-instructions\.md|instructions\/|prompts\/)/i;
