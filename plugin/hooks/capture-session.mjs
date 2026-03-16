import { appendFileSync } from "node:fs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

if (!process.env.CLAUDE_ENV_FILE) {
  process.exit(0);
}

let parsed = {};
try {
  parsed = JSON.parse(input || "{}");
} catch {
  process.exit(0);
}

const exports = [];
const mappings = [
  ["CLAUDE_SESSION_SHARE_SESSION_ID", parsed.session_id],
  ["CLAUDE_SESSION_SHARE_TRANSCRIPT_PATH", parsed.transcript_path],
  ["CLAUDE_SESSION_SHARE_CWD", parsed.cwd]
];

for (const [key, value] of mappings) {
  if (typeof value !== "string" || !value) continue;
  exports.push(`export ${key}=${shellQuote(value)}`);
}

if (exports.length > 0) {
  appendFileSync(process.env.CLAUDE_ENV_FILE, `${exports.join("\n")}\n`, "utf8");
}
