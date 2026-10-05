import PocketBase from "pocketbase";
import type { LoginManager } from "../../vendor/relay/src/LoginManager";
import { customFetch } from "../../vendor/relay/src/customFetch";
import { agentProfile, identityName, mintAgentIdentity } from "../mcp-identity.js";
import { assertAuthServerMatches } from "../auth-server.js";
import { readStoredLogin } from "./auth-storage";
import { buildConfig } from "./build-config";

type Session = { userId: string; token: string; authUrl: string; current: () => boolean };
type Agent = { id: string; user: string; name: string; avatar?: string; collectionId?: string; collectionName?: string };

export class AgentDirectory {
  constructor(private session: () => Promise<Session>, private fetch = customFetch) {}

  private check(session: Session) {
    if (!session.current()) throw new Error("The logged-in user changed during the agent request. Retry under the intended account.");
  }

  private client(session: Session) {
    this.check(session);
    const pb = new PocketBase(session.authUrl).autoCancellation(false);
    pb.authStore.save(session.token, { id: session.userId });
    pb.beforeSend = (url, options) => {
      this.check(session);
      return { url, options: { ...options, fetch: this.fetch, signal: AbortSignal.timeout(10_000) } };
    };
    return pb;
  }

  private profile(pb: PocketBase, session: Session, record: Agent) {
    this.check(session);
    if (!/^[a-z0-9]{15}$/.test(record.id) || record.user !== session.userId) throw new Error("Agent does not belong to the logged-in user.");
    const name = identityName(record.name);
    const picture = record.avatar ? pb.files.getUrl({ ...record, collectionName: "user_agents" }, record.avatar) : undefined;
    return { ...agentProfile(record.id, name, picture), user: record.user };
  }

  private async find(pb: PocketBase, session: Session, name: string) {
    const result = await pb.collection("user_agents").getList<Agent>(1, 1, {
      filter: pb.filter("user = {:user} && name = {:name}", { user: session.userId, name }),
    });
    this.check(session);
    return result.items[0] ?? null;
  }

  async resolve({ id, name }: { id?: string; name?: string }) {
    if (id !== undefined && !/^[a-z0-9]{15}$/.test(id)) throw new Error("Agent ID must be a 15-character user_agents record ID.");
    if (!id && !name) throw new Error("Select an agent with --agent <id> or --agent-name <name>.");
    const session = await this.session(), pb = this.client(session);
    const record = id ? await pb.collection("user_agents").getOne<Agent>(id) : await this.find(pb, session, identityName(name));
    if (!record) throw new Error(`Agent is not registered. Run relay agent create --name ${JSON.stringify(name)}, then retry.`);
    return this.profile(pb, session, record);
  }

  async list(page = 1, limit = 100) {
    const session = await this.session(), pb = this.client(session);
    const result = await pb.collection("user_agents").getList<Agent>(page, limit, {
      filter: pb.filter("user = {:user}", { user: session.userId }), sort: "name,id",
    });
    return { agents: result.items.map(record => this.profile(pb, session, record)),
      nextPage: result.page < result.totalPages ? result.page + 1 : null };
  }

  async create(name: string) {
    name = identityName(name);
    const session = await this.session(), pb = this.client(session);
    const existing = await this.find(pb, session, name);
    if (existing) return { agent: this.profile(pb, session, existing), created: false };
    const identity = mintAgentIdentity(name);
    // No bearer credential is sent to the public seeded-avatar endpoint.
    const avatar = await this.fetch(identity.picture, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!avatar.ok || !avatar.headers.get("content-type")?.startsWith("image/svg+xml")) throw new Error("The avatar service did not return an SVG image.");
    const image = await avatar.arrayBuffer();
    if (!image.byteLength || image.byteLength > 256 * 1024) throw new Error("Agent avatar exceeds the 256 KiB limit.");
    this.check(session);
    const body = new FormData();
    body.set("id", identity.id);
    body.set("user", session.userId);
    body.set("name", name);
    body.set("avatar", new Blob([image], { type: "image/svg+xml" }), "avatar.svg");
    try {
      const record = await pb.collection("user_agents").create<Agent>(body);
      return { agent: this.profile(pb, session, record), created: true };
    } catch (error) {
      // A concurrent create or a lost successful reply may already have made
      // this unique (user,name) record. Read it; never blindly repeat a POST.
      this.check(session);
      const record = await this.find(pb, session, name).catch(() => null);
      if (record) return { agent: this.profile(pb, session, record), created: false };
      throw error;
    }
  }
}

export function agentDirectoryForLogin(login: LoginManager) {
  return new AgentDirectory(async () => {
    const user = login.user;
    if (!login.loggedIn || !user?.id) throw new Error("Not logged in. Run relay login first.");
    return { userId: user.id, token: user.token, authUrl: login.getEndpointManager().getAuthUrl(),
      current: () => login.loggedIn && login.user?.id === user.id };
  });
}

export function agentDirectoryFromStoredLogin() {
  return new AgentDirectory(async () => {
    const login = readStoredLogin();
    if (!login?.token) throw new Error("Not logged in. Run relay login first.");
    assertAuthServerMatches(login.server, buildConfig.authUrl);
    const pb = new PocketBase(buildConfig.authUrl).autoCancellation(false);
    pb.authStore.save(login.token);
    // Resolve the authenticated owner from the service, not unsigned JWT claims.
    const auth = await pb.collection("users").authRefresh({ fetch: customFetch, signal: AbortSignal.timeout(10_000) });
    return { userId: auth.record.id, token: auth.token, authUrl: buildConfig.authUrl,
      current: () => readStoredLogin()?.token === login.token };
  });
}
