import { createHash } from "node:crypto";
import { parseCriticMarkup } from "../../vendor/relay-comments/src/critic/parse";
import { buildReviewRuns, reviewAnchorId, reviewAnchorType } from "../../vendor/relay-comments/src/critic/review-runs";
import { replacementForMark } from "../../vendor/relay-comments/src/critic/transform";
import { sanitizeCommentText } from "../../vendor/relay-comments/src/critic/comment-text";
import { parseNativeHighlights } from "../../vendor/relay-comments/src/markdown/highlights";
import { MAX_DOCUMENT_CHARS } from "../mcp-editor-clients.js";

export function reviewModel(text: string) {
  if (typeof text !== "string" || text.length > MAX_DOCUMENT_CHARS) throw new Error("Review text exceeds 128 Ki characters.");
  const marks = parseCriticMarkup(text);
  if (marks.length > 1000) throw new Error("Document exceeds the limit of 1000 review marks.");
  const highlights = parseNativeHighlights(text, marks);
  const runs = buildReviewRuns(text, marks, highlights);
  if (runs.length > 1000) throw new Error("Document exceeds the limit of 1000 review items.");
  return { hash: createHash("sha256").update(text).digest("hex"), marks, highlights, runs };
}

export function reviewSnapshot(text: string) {
  const { hash, marks, runs } = reviewModel(text);
  return {
    hash,
    threads: runs.map(run => ({
      id: reviewAnchorId(run.anchor), kind: reviewAnchorType(run.anchor),
      from: run.from, to: run.to,
      anchor: run.anchor.kind === "native-highlight" ? run.anchor.highlight.text : run.anchor.mark.content,
      ...(run.anchor.kind === "critic" && run.anchor.mark.type === "substitution" ? { oldText: run.anchor.mark.oldText, newText: run.anchor.mark.newText } : {}),
      nativeHighlight: run.anchor.kind === "native-highlight",
      comments: run.comments.map(comment => ({ text: comment.content, metadata: comment.metadata ?? {} })),
    })),
    invalid: marks.filter(mark => !mark.valid).map(mark => ({ from: mark.from, to: mark.to, error: mark.error })),
  };
}

// Notification identity deliberately excludes positions. This compares review
// activity, including multiplicity, without treating a hash as a durable ID.
export function reviewFingerprint(text: string) {
  const { hash, runs } = reviewModel(text);
  return { hash, marks: runs.map(run => ({
    kind: reviewAnchorType(run.anchor),
    key: createHash("sha256").update(JSON.stringify([
      run.anchor.kind === "native-highlight" ? run.anchor.highlight.raw : run.anchor.mark.raw,
      run.comments.map(comment => comment.raw),
    ])).digest("hex"),
  })) };
}

export type CommentEdit = {
  action: "create" | "reply" | "resolve" | "suggest" | "accept" | "reject";
  expectedHash: string; threadId?: string; from?: number; to?: number;
  text?: string; suggestion?: "addition" | "deletion" | "replacement";
};

export function editComment(source: string, input: CommentEdit, identity: string | { id: string; name: string } = "Relay MCP", date = new Date().toISOString()): string {
  const model = reviewModel(source);
  if (input.expectedHash !== model.hash) throw new Error("Document changed since review. Read the comments again before editing.");
  if (model.marks.some(mark => !mark.valid)) throw new Error("Resolve malformed review markup before editing comments.");
  const safeText = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 16_384 || /\{(?:\+\+|--|~~|==|>>|\{)/.test(value)) {
      throw new Error("Provide nonempty text within 16 Ki characters without nested CriticMarkup.");
    }
    return value;
  };
  const comment = () => {
    const author = typeof identity === "string" ? identity : identity.name;
    const id = typeof identity === "string" ? undefined : identity.id;
    if (!author.trim() || author.length > 100 || /["{}<>\r\n]/.test(author)) throw new Error("Invalid comment display identity.");
    if (id !== undefined && !/^[a-z0-9]{15}$/.test(id)) throw new Error("Invalid agent author ID.");
    return `{{${id ? `authorId="${id}" ` : ""}author="${author}" date="${date}">>${sanitizeCommentText(safeText(input.text))}<<}}`;
  };
  let from: number, to: number, insert: string;
  if (input.action === "create" || input.action === "suggest") {
    from = input.from!; to = input.to!;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > source.length) throw new Error("Invalid UTF-16 selection range.");
    for (const offset of [from, to]) {
      if (/[\uD800-\uDBFF]/.test(source[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(source[offset] ?? "")) throw new Error("Selection splits a Unicode character.");
    }
    const selected = source.slice(from, to);
    const native = model.highlights.find(mark => (mark.from === from && mark.to === to) || (mark.contentFrom === from && mark.contentTo === to));
    const overlaps = (mark: { from: number; to: number }) => from === to ? mark.from < from && from < mark.to : mark.from < to && from < mark.to;
    if (model.marks.some(overlaps) || model.highlights.some(mark => overlaps(mark) && !(input.action === "create" && mark === native))) {
      throw new Error("Selection overlaps existing review markup; reply to its thread instead.");
    }
    if (input.action === "create") {
      if (native && model.runs.some(run => run.anchor.kind === "native-highlight" && run.anchor.highlight === native && run.comments.length)) {
        throw new Error("This highlight already has a discussion; reply to its thread instead.");
      }
      if (native) { from = native.to; to = native.to; insert = comment(); }
      else { if (selected.includes("==}")) throw new Error("Selection contains a highlight delimiter."); insert = from === to ? comment() : `{==${selected}==}${comment()}`; }
    } else {
      const value = input.suggestion === "deletion" ? "" : safeText(input.text);
      if (input.suggestion === "addition" && from === to && !value.includes("++}")) insert = `{++${value}++}`;
      else if (input.suggestion === "deletion" && from < to && !selected.includes("--}")) insert = `{--${selected}--}`;
      else if (input.suggestion === "replacement" && from < to && ![selected, value].some(text => text.includes("~~}") || text.includes("~>"))) insert = `{~~${selected}~>${value}~~}`;
      else throw new Error("Invalid suggestion kind, selection, or delimiter.");
    }
  } else {
    const run = model.runs.find(run => reviewAnchorId(run.anchor) === input.threadId);
    if (!run) throw new Error("Review thread is missing or stale; read it again.");
    from = run.from; to = run.to;
    if (input.action === "reply") { from = to; insert = comment(); }
    else if (input.action === "resolve") {
      if (run.anchor.kind === "native-highlight") insert = run.anchor.highlight.raw;
      else if (["addition", "deletion", "substitution"].includes(run.anchor.mark.type)) insert = run.anchor.mark.raw;
      else insert = replacementForMark(run.anchor.mark, "accept");
    } else if ((input.action === "accept" || input.action === "reject") && run.anchor.kind === "critic" && ["addition", "deletion", "substitution"].includes(run.anchor.mark.type)) {
      insert = replacementForMark(run.anchor.mark, input.action);
    } else throw new Error("Only suggestions can be accepted or rejected.");
  }
  const result = source.slice(0, from) + insert + source.slice(to);
  const checked = reviewModel(result);
  if (checked.marks.some(mark => !mark.valid)) throw new Error("The operation would create invalid review markup.");
  return result;
}
