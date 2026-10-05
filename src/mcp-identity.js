import { createHash, randomInt } from "node:crypto";

const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
export function identityName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /["{}<>\x00-\x1f\x7f]/.test(value)) throw new Error("Agent name must be 1–100 characters without control characters or markup delimiters.");
  return value.trim();
}

export function mintAgentIdentity(name = "Relay MCP") {
  const id = Array.from({ length: 15 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return agentProfile(id, name);
}

export function agentProfile(id, name, picture = `https://avatars.relay.md/?seed=${id}`) {
  const colors = ["#7c3aed", "#2563eb", "#0891b2", "#059669", "#d97706", "#db2777"];
  const color = colors[createHash("sha256").update(id).digest()[0] % colors.length];
  return { id, name: identityName(name), picture, color, colorLight: `${color}33` };
}
