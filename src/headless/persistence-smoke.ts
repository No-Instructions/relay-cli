import * as Y from "yjs";
import { DefaultTimeProvider } from "../../vendor/relay/src/TimeProvider";
import { IndexeddbPersistence } from "../../vendor/relay/src/storage/y-indexeddb";
import { HSMStore } from "../../vendor/relay/src/merge-hsm/persistence";

export async function writeYIndexedDbSmoke(dbName: string, content: string): Promise<void> {
  const timeProvider = new DefaultTimeProvider();
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(dbName, doc, null, null, timeProvider);
  await persistence.whenSynced;
  doc.getText("text").insert(0, content);
  await persistence.destroy();
  doc.destroy();
  timeProvider.destroy();
}

export async function readYIndexedDbSmoke(dbName: string): Promise<string> {
  const timeProvider = new DefaultTimeProvider();
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(dbName, doc, null, null, timeProvider);
  await persistence.whenSynced;
  const content = doc.getText("text").toString();
  await persistence.destroy();
  doc.destroy();
  timeProvider.destroy();
  return content;
}

export async function writeHsmStoreSmoke(appId: string, guid: string): Promise<void> {
  const store = new HSMStore(appId);
  await store.saveState(guid, {
    guid,
    path: "/note.md",
    lca: null,
    disk: { hash: "disk-hash", mtime: 123 },
    localSnapshot: new Uint8Array([1, 2, 3]),
    lastStatePath: "idle",
    fork: null,
    persistedAt: 456,
  } as any);
  await store.destroy();
}

export async function readHsmStoreSmoke(appId: string, guid: string): Promise<unknown> {
  const store = new HSMStore(appId);
  const state = await store.loadState(guid);
  const guids = await store.getAllStateGuids();
  const meta = await store.getAllStateMeta();
  await store.destroy();
  return {
    state: state
      ? {
          guid: state.guid,
          path: state.path,
          disk: state.disk,
          localSnapshot: state.localSnapshot ? [...state.localSnapshot] : null,
          lastStatePath: state.lastStatePath,
          fork: state.fork,
          persistedAt: state.persistedAt,
        }
      : null,
    guids,
    meta: meta.map((entry) => ({
      guid: entry.guid,
      path: entry.path,
      disk: entry.disk,
      localSnapshot: entry.localSnapshot ? [...entry.localSnapshot] : null,
      lastStatePath: entry.lastStatePath,
      hasFork: entry.hasFork,
      persistedAt: entry.persistedAt,
    })),
  };
}
