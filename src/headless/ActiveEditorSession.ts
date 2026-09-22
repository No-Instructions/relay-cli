import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { diff_match_patch } from "diff-match-patch";
import type { Awareness } from "y-protocols/awareness.js";
import type { Document } from "../../vendor/relay/src/Document";
import type { MergeHSM } from "../../vendor/relay/src/merge-hsm/MergeHSM";
import type {
  MergeEffect,
  PositionedChange,
} from "../../vendor/relay/src/merge-hsm/types";

const dmp = new diff_match_patch();

export type ActiveEditorPeer = {
  clientId: number;
  user: {
    id?: string;
    name: string;
    color?: string;
    colorLight?: string;
  };
  selection: { anchor: number; head: number } | null;
};

export type ActiveEditorFrame = {
  sessionId: string;
  path: string;
  revision: number;
  text: string;
  peers: ActiveEditorPeer[];
};

export type ActiveEditorApplyResult =
  | {
      applied: true;
      revision: number;
      text: string;
      changes: PositionedChange[];
      peers: ActiveEditorPeer[];
    }
  | {
      applied: false;
      revision: number;
      text: string;
      reason: "overlap" | "inactive";
      peers: ActiveEditorPeer[];
    };

type TextEdit = PositionedChange;

export class ActiveEditorSession {
  readonly id = randomUUID();
  readonly viewId = `headless-editor-${this.id}`;
  readonly guid: string;

  private awareness: Awareness | null = null;
  private closed = false;
  private hsm: MergeHSM;
  private lockAcquired = false;
  private previousAwarenessState: Record<string, unknown> | null = null;
  private revision = 0;
  private text: string;
  private unsubscribeEffects: (() => void) | null = null;
  private readonly awarenessChanged = (event: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    const localClientId = this.awareness?.doc.clientID;
    if (
      [...event.added, ...event.updated, ...event.removed].some(
        (clientId) => clientId !== localClientId,
      )
    ) {
      this.revision += 1;
    }
  };

  private constructor(
    private readonly document: Document,
    readonly path: string,
    initialText: string,
    private readonly user: {
      id?: string;
      name: string;
      color: string;
      colorLight: string;
    },
  ) {
    this.guid = document.guid;
    this.text = initialText;
    this.hsm = document.hsm!;
  }

  static async open(
    document: Document,
    path: string,
    user: {
      id?: string;
      name?: string;
      color?: string;
      colorLight?: string;
    } = {},
  ): Promise<ActiveEditorSession> {
    const tfile = document.tfile;
    if (!tfile) throw new Error(`Active editor file is not materialized: ${path}`);
    const initialText = await document.vault.read(tfile);
    const color = user.color ?? "#7456c8";
    const session = new ActiveEditorSession(document, path, initialText, {
      id: user.id,
      name: user.name?.trim() || "Editor agent",
      color,
      colorLight: user.colorLight ?? `${color}33`,
    });
    try {
      await session.activate();
      return session;
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }

  frame(): ActiveEditorFrame {
    this.assertOpen();
    this.refreshFromLocalDoc();
    return {
      sessionId: this.id,
      path: this.path,
      revision: this.revision,
      text: this.text,
      peers: this.readPeers(),
    };
  }

  apply(input: {
    baseText: string;
    desiredText: string;
    cursor?: number | null;
    selection?: { anchor: number; head: number } | null;
  }): ActiveEditorApplyResult {
    this.assertOpen();
    this.refreshFromLocalDoc();

    if (!this.hsm.matches("active.tracking")) {
      return {
        applied: false,
        revision: this.revision,
        text: this.text,
        reason: "inactive",
        peers: this.readPeers(),
      };
    }

    const rebased = rebaseActiveEditorText(
      input.baseText,
      input.desiredText,
      this.text,
    );
    if (!rebased.ok) {
      return {
        applied: false,
        revision: this.revision,
        text: this.text,
        reason: "overlap",
        peers: this.readPeers(),
      };
    }

    const changes = computePositionedChanges(this.text, rebased.text);
    if (changes.length > 0) {
      this.text = rebased.text;
      this.revision += 1;
      this.hsm.send({
        type: "CM6_CHANGE",
        changes,
        docText: this.text,
        viewId: this.viewId,
        userEvent: "input",
      });
      this.document.requestSave();
    }
    this.publishSelection(input.selection, input.cursor);

    return {
      applied: true,
      revision: this.revision,
      text: this.text,
      changes,
      peers: this.readPeers(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeEffects?.();
    this.unsubscribeEffects = null;
    if (this.awareness) {
      this.awareness.off("change", this.awarenessChanged);
      this.awareness.setLocalState(this.previousAwarenessState);
    }
    this.awareness = null;

    if (this.lockAcquired) {
      (this.document.requestSave as unknown as { cancel?: () => void }).cancel?.();
      try {
        await this.document.save();
      } finally {
        this.document.userLock = false;
        this.lockAcquired = false;
        await this.document.releaseLock();
      }
    }
  }

  private async activate(): Promise<void> {
    if (!this.hsm) throw new Error(`Document has no merge HSM: ${this.path}`);
    this.document.userLock = true;
    this.hsm = this.document.acquireLock({
      getViewData: () => this.text,
    });
    this.lockAcquired = true;
    this.unsubscribeEffects = this.hsm.effects.subscribe((effect) =>
      this.handleEffect(effect),
    );
    this.hsm.attachEditorView({ getViewData: () => this.text }, this.text);

    await withTimeout(
      this.hsm.awaitState(
        (state) =>
          state === "active.tracking" ||
          state.startsWith("active.conflict") ||
          state === "destroyed",
      ),
      30_000,
      `Timed out entering ACTIVE MODE for ${this.path}`,
    );
    if (!this.hsm.matches("active.tracking")) {
      throw new Error(`Cannot open active editor in HSM state for ${this.path}`);
    }

    this.hsm.bootstrapEditorView(this.viewId, this.text);
    this.refreshFromLocalDoc();
    this.attachAwareness();
  }

  private handleEffect(effect: MergeEffect): void {
    if (this.closed) return;
    if (effect.type === "SET_CM6" && effect.targetView === this.viewId) {
      if (effect.text !== this.text) {
        this.text = effect.text;
        this.revision += 1;
      }
      return;
    }
    if (
      effect.type === "DISPATCH_CM6" &&
      effect.originView !== this.viewId
    ) {
      this.refreshFromLocalDoc();
    }
  }

  private refreshFromLocalDoc(): void {
    const localText = this.document.localDoc
      ?.getText("contents")
      .toString();
    if (localText !== undefined && localText !== this.text) {
      this.text = localText;
      this.revision += 1;
    }
  }

  private attachAwareness(): void {
    const awareness = this.document._provider?.awareness ?? null;
    if (!awareness) return;
    this.awareness = awareness;
    this.previousAwarenessState = awareness.getLocalState();
    awareness.setLocalStateField("user", this.user);
    awareness.setLocalStateField("cursor", null);
    awareness.on("change", this.awarenessChanged);
  }

  private publishSelection(
    selection?: { anchor: number; head: number } | null,
    cursor?: number | null,
  ): void {
    if (!this.awareness || this.hsm.hasFork()) return;
    if (selection === null || cursor === null) {
      this.awareness.setLocalStateField("cursor", null);
      return;
    }

    const localText = this.document.localDoc?.getText("contents");
    if (!localText) return;
    const anchor = clamp(selection?.anchor ?? cursor ?? this.text.length, 0, this.text.length);
    const head = clamp(selection?.head ?? cursor ?? anchor, 0, this.text.length);
    this.awareness.setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(localText, anchor),
      head: Y.createRelativePositionFromTypeIndex(localText, head),
    });
  }

  private readPeers(): ActiveEditorPeer[] {
    if (!this.awareness || this.hsm.hasFork()) return [];
    const localDoc = this.document.localDoc;
    const localText = localDoc?.getText("contents");
    if (!localDoc || !localText) return [];

    const peers: ActiveEditorPeer[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.doc.clientID) continue;
      const rawUser = state.user ?? {};
      let selection: { anchor: number; head: number } | null = null;
      const cursor = state.cursor;
      if (cursor?.anchor && cursor?.head) {
        const anchor = Y.createAbsolutePositionFromRelativePosition(
          cursor.anchor,
          localDoc,
        );
        const head = Y.createAbsolutePositionFromRelativePosition(
          cursor.head,
          localDoc,
        );
        if (
          anchor?.type === localText &&
          head?.type === localText &&
          anchor.index <= this.text.length &&
          head.index <= this.text.length
        ) {
          selection = { anchor: anchor.index, head: head.index };
        }
      }
      peers.push({
        clientId,
        user: {
          ...(typeof rawUser.id === "string" ? { id: rawUser.id } : {}),
          name:
            typeof rawUser.name === "string" && rawUser.name
              ? rawUser.name
              : `Peer ${clientId}`,
          ...(typeof rawUser.color === "string"
            ? { color: rawUser.color }
            : {}),
          ...(typeof rawUser.colorLight === "string"
            ? { colorLight: rawUser.colorLight }
            : {}),
        },
        selection,
      });
    }
    return peers.sort((left, right) => left.clientId - right.clientId);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Active editor session is closed: ${this.id}`);
  }
}

export function computePositionedChanges(
  from: string,
  to: string,
): PositionedChange[] {
  const diffs = dmp.diff_main(from, to);
  dmp.diff_cleanupSemantic(diffs);
  const changes: PositionedChange[] = [];
  let position = 0;
  for (let index = 0; index < diffs.length; index += 1) {
    const [operation, value] = diffs[index]!;
    if (operation === 0) {
      position += value.length;
      continue;
    }
    if (operation === -1) {
      const next = diffs[index + 1];
      if (next?.[0] === 1) {
        changes.push({
          from: position,
          to: position + value.length,
          insert: next[1],
        });
        position += value.length;
        index += 1;
      } else {
        changes.push({
          from: position,
          to: position + value.length,
          insert: "",
        });
        position += value.length;
      }
      continue;
    }
    changes.push({ from: position, to: position, insert: value });
  }
  return coalesceChanges(changes);
}

export function rebaseActiveEditorText(
  base: string,
  desired: string,
  current: string,
): { ok: true; text: string } | { ok: false } {
  if (current === base) return { ok: true, text: desired };
  if (desired === base) return { ok: true, text: current };

  const agentChanges = computePositionedChanges(base, desired);
  const concurrentChanges = computePositionedChanges(base, current);
  for (const agent of agentChanges) {
    for (const concurrent of concurrentChanges) {
      if (changesConflict(agent, concurrent)) return { ok: false };
    }
  }

  const rebased = agentChanges.map((change) => ({
    from: mapBasePosition(change.from, concurrentChanges),
    to: mapBasePosition(change.to, concurrentChanges),
    insert: change.insert,
  }));
  return { ok: true, text: applyChanges(current, rebased) };
}

function changesConflict(left: TextEdit, right: TextEdit): boolean {
  const leftInsert = left.from === left.to;
  const rightInsert = right.from === right.to;
  if (leftInsert && rightInsert) return left.from === right.from;
  if (leftInsert) return left.from >= right.from && left.from <= right.to;
  if (rightInsert) return right.from >= left.from && right.from <= left.to;
  return left.from < right.to && right.from < left.to;
}

function mapBasePosition(position: number, changes: TextEdit[]): number {
  let delta = 0;
  for (const change of changes) {
    if (
      change.to < position ||
      (change.to === position && change.from !== change.to)
    ) {
      delta += change.insert.length - (change.to - change.from);
      continue;
    }
    if (change.from < position && position < change.to) {
      throw new Error("Cannot map through an overlapping active-editor change");
    }
    if (change.from >= position) break;
  }
  return position + delta;
}

function applyChanges(text: string, changes: TextEdit[]): string {
  let result = text;
  for (const change of [...changes].sort((left, right) => right.from - left.from)) {
    result =
      result.slice(0, change.from) +
      change.insert +
      result.slice(change.to);
  }
  return result;
}

function coalesceChanges(changes: TextEdit[]): TextEdit[] {
  const result: TextEdit[] = [];
  for (const change of changes) {
    const previous = result.at(-1);
    if (previous && previous.to === change.from) {
      previous.to = change.to;
      previous.insert += change.insert;
    } else {
      result.push({ ...change });
    }
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
