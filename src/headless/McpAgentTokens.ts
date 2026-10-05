import { Decoder } from "cbor-x";
import { TokenStore } from "../../vendor/relay/src/TokenStore";
import type { LiveTokenStore } from "../../vendor/relay/src/LiveTokenStore";
import type { ClientToken } from "../../vendor/relay/src/client/types";
import type { LoginManager } from "../../vendor/relay/src/LoginManager";
import { DefaultTimeProvider, type TimeProvider } from "../../vendor/relay/src/TimeProvider";
import type { Document } from "../../vendor/relay/src/Document";
import { S3RN, S3RemoteDocument } from "../../vendor/relay/src/S3RN";
import { customFetch, getRelayRequestHeaders } from "../../vendor/relay/src/customFetch";

const decoder = new Decoder({ mapsAsObjects: false });
const tokenOwners = new WeakMap<object, symbol>();
const bindings = new WeakMap<Document, { owner: symbol | null; refresh: Document["refreshProvider"] }>();

// Consistency check on the HTTPS mint response, not signature verification.
// The sync server verifies the signed CWT. Legacy tokens cannot carry agents.
export function assertAgentToken(token: string, agent: string, subject: string, docId: string, readOnly = false) {
  try {
    if (typeof token !== "string" || token.length > 65536 || !/^[a-zA-Z0-9_-]+={0,2}$/.test(token)) throw new Error();
    let envelope: any = decoder.decode(Buffer.from(token, "base64url"));
    for (let index = 0; index < 2 && envelope && !Array.isArray(envelope); index++) envelope = envelope.value;
    if (!Array.isArray(envelope) || !(envelope[2] instanceof Uint8Array)) throw new Error();
    const claims = decoder.decode(envelope[2]);
    if (!(claims instanceof Map) || claims.get(-80205) !== agent || claims.get(2) !== subject ||
        ![...(readOnly ? [] : [`doc:${docId}:rw`]), `doc:${docId}:r`].includes(claims.get(-80201))) throw new Error();
  } catch { throw new Error(`The token service did not return the requested ${readOnly ? "read-only " : ""}agent identity, user and document. An agent-capable token provider is required.`); }
}

export class McpAgentTokens extends TokenStore<ClientToken> {
  readonly owner = Symbol("MCP agent token owner");
  private abort = new AbortController();

  constructor(login: LoginManager, time: TimeProvider, agent: string, device: string, readOnly = false) {
    const abort = new AbortController();
    const subject = login.user?.id;
    // TokenStore.destroy() owns its time provider. Never give it the runtime's
    // shared provider: closing one editor must not cancel daemon-wide timers.
    const timers = new DefaultTimeProvider();
    timers.now = () => time.now();
    super({
      log: () => {},
      getTimeProvider: () => timers,
      getJwtExpiry: token => token.expiryTime ?? 0,
      refresh: (resource, success, failure, context) => {
        void (async () => {
          const entity = S3RN.decode(resource);
          if (!(entity instanceof S3RemoteDocument)) throw new Error("Agent tokens require a remote text document.");
          if (!subject || !login.loggedIn || login.user?.id !== subject) throw new Error("Agent token owner is no longer logged in.");
          const response = await customFetch(`${login.getEndpointManager().getApiUrl()}/token`, {
            method: "POST", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
            headers: { ...getRelayRequestHeaders(), "Content-Type": "application/json", Authorization: `Bearer ${login.user.token}` },
            body: JSON.stringify({ docId: entity.documentId, relay: entity.relayId, folder: entity.folderId, agent,
              ...(readOnly ? { authorization: "read-only" } : {}),
              ...(device ? { device } : {}), ...(context?.reconcile && context.heldToken?.token ? { supersede: context.heldToken.token } : {}) }),
            relayNetworkDomain: "api",
          });
          if (!response.ok) throw new Error(`Agent token request failed with HTTP ${response.status}.`);
          const token = await response.json() as ClientToken;
          if (abort.signal.aborted || !login.loggedIn || login.user?.id !== subject) throw new Error("Agent token owner changed during the request.");
          assertAgentToken(token.token, agent, subject, entity.documentId, readOnly);
          if (token.docId !== entity.documentId || !(readOnly ? ["read-only"] : ["full", "read-only"]).includes(token.authorization!) ||
              typeof token.url !== "string" || !/^wss?:\/\//.test(token.url) || !Number.isFinite(token.expiryTime)) throw new Error("Invalid agent document token response.");
          tokenOwners.set(token, this.owner);
          success(token);
        })().catch(failure);
      },
    }, 1);
    this.abort = abort;
  }

  override destroy() { this.abort.abort(); super.destroy(); }
}

// A document already has one daemon-owned provider. Give that provider a
// session-local token cache; do not create another sync engine or connection.
// A read-only binding carries the document's own sync too while it is held:
// local edits to this document wait for release to reach the server.
export async function bindMcpAgent(document: Document, time: TimeProvider, agent: string, device: string, readOnly = false): Promise<() => void> {
  if (!/^[a-z0-9]{15}$/.test(agent)) throw new Error("Invalid MCP agent identity.");
  const folder = document.sharedFolder;
  if (folder?.relayId && !folder.localOnly) {
    document.s3rn = new S3RemoteDocument(folder.relayId, folder.guid, document.guid);
  }
  if (!(document.s3rn instanceof S3RemoteDocument)) return () => {};
  const store = new McpAgentTokens(document.loginManager, time, agent, device, readOnly);
  const previous = document.tokenStore;
  const previousToken = document.clientToken;
  let binding = bindings.get(document);
  if (!binding) {
    binding = { owner: null, refresh: document.refreshProvider.bind(document) };
    const guard = binding;
    document.refreshProvider = token => {
      if ((tokenOwners.get(token) ?? null) !== guard.owner) throw new Error("Stale token from another document identity.");
      guard.refresh(token);
    };
    bindings.set(document, binding);
  }
  try {
    const token = await store.getTokenOnce(S3RN.encode(document.s3rn), document.path);
    document.disconnect();
    binding.owner = store.owner;
    // Document uses only TokenStore operations, never LiveTokenStore's binary
    // file-token methods. Keep this adaptation out of the vendored runtime.
    document.tokenStore = store as unknown as LiveTokenStore;
    document.refreshProvider(token);
    store.start();
  } catch (error) {
    store.destroy();
    if (binding.owner === store.owner) {
      binding.owner = null;
      document.tokenStore = previous;
      document.refreshProvider(previousToken);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    document.disconnect();
    store.destroy();
    binding!.owner = null;
    document.tokenStore = previous;
    document.refreshProvider(previousToken);
    // Resume the daemon's ordinary synchronization under its own token cache.
    void document.connect();
  };
}
