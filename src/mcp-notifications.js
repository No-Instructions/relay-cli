import { randomUUID } from "node:crypto";

// One bounded observation/history per document in the daemon, shared by all
// MCP processes. Resume credentials and acknowledgements are per subscriber.
export class McpNotifications {
  constructor(runtimes, { now = Date.now, retentionMs = 600_000, maxEvents = 256, pollMs = 2000 } = {}) {
    this.runtimes = runtimes;
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxEvents = maxEvents;
    this.channels = new Map();
    this.subscriptions = new Map();
    this.stopped = false;
    this.timer = setInterval(() => { void this.reconcile(); }, pollMs);
    this.timer.unref();
  }

  valid(channel) {
    return !channel.closed && this.runtimes.get(channel.root) === channel.runtime && channel.identity === channel.runtime.mcpResourceIdentity();
  }

  revoke(channel) {
    channel.closed = true;
    channel.unwatch?.();
    channel.unwatch = null;
    channel.events.length = 0;
    channel.snapshot = null;
  }

  emit(channel, event) {
    channel.events.push({ ...event, sequence: ++channel.sequence, time: new Date(this.now()).toISOString() });
    if (channel.events.length > this.maxEvents) channel.events.shift();
  }

  refresh(channel) {
    channel.dirty = true;
    if (channel.refreshing) return channel.refreshing;
    channel.refreshing = (async () => {
      for (let attempt = 0; channel.dirty && attempt < 4; attempt++) {
        channel.dirty = false;
        if (!this.valid(channel)) { this.revoke(channel); return; }
        let snapshot;
        try { snapshot = await channel.runtime.readMcpReviewFingerprint(channel.path); }
        catch { snapshot = null; }
        // Never publish a read that crossed an account/root replacement.
        if (!this.valid(channel)) { this.revoke(channel); return; }
        const before = channel.snapshot;
        if (channel.initialized) {
          if (!snapshot && before) this.emit(channel, { type: "document.unavailable" });
          else if (snapshot && !before) this.emit(channel, { type: "document.available", hash: snapshot.hash });
          else if (snapshot && before && snapshot.hash !== before.hash) {
            this.emit(channel, { type: "document.changed", hash: snapshot.hash });
            const remaining = new Map();
            for (const mark of before.marks) remaining.set(mark.key, (remaining.get(mark.key) ?? 0) + 1);
            let added = 0;
            for (const mark of snapshot.marks) {
              const count = remaining.get(mark.key) ?? 0;
              if (count) remaining.set(mark.key, count - 1); else added++;
            }
            const removed = [...remaining.values()].reduce((sum, count) => sum + count, 0);
            if (added || removed) this.emit(channel, { type: "review.changed", hash: snapshot.hash, added, removed });
          }
        }
        channel.snapshot = snapshot;
        channel.initialized = true;
      }
    })().finally(() => { channel.refreshing = null; });
    return channel.refreshing;
  }

  cursor(channel, sequence = channel.sequence) { return `${channel.epoch}:${sequence}`; }

  sequence(channel, cursor) {
    if (typeof cursor !== "string" || !cursor.startsWith(`${channel.epoch}:`)) return null;
    const value = cursor.slice(channel.epoch.length + 1);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const sequence = Number(value);
    return Number.isSafeInteger(sequence) && sequence <= channel.sequence ? sequence : null;
  }

  describe(subscription) {
    const channel = subscription.channel;
    if (!this.valid(channel)) {
      this.revoke(channel);
      return { subscriptionId: subscription.id, resyncRequired: true };
    }
    const oldest = channel.events[0]?.sequence ?? channel.sequence + 1;
    return { subscriptionId: subscription.id, folder: channel.root, path: channel.path,
      cursor: this.cursor(channel), acknowledged: this.cursor(channel, subscription.ack),
      unread: channel.events.filter(event => event.sequence > subscription.ack).length,
      resyncRequired: subscription.ack < oldest - 1, available: channel.snapshot !== null };
  }

  async handle(owner, scope, input) {
    if (this.stopped) throw new Error("Notifications are stopping.");
    if (input.action === "follow") {
      const root = input.repo;
      if (scope && root !== scope) throw new Error("This MCP client is restricted to its selected folder.");
      const runtime = this.runtimes.get(root);
      if (!runtime) throw new Error("No headless Relay runtime is running for this exact folder root.");
      const key = JSON.stringify([root, input.path]);
      let channel = this.channels.get(key);
      if (channel && !this.valid(channel)) { this.revoke(channel); this.channels.delete(key); channel = null; }
      if (this.subscriptions.size >= 128) throw new Error("Notification subscriber limit reached. Unfollow an existing subscription.");
      if (!channel) {
        if (this.channels.size >= 64) throw new Error("Notification document limit reached. Unfollow an existing document.");
        channel = { key, root, path: input.path, runtime, identity: runtime.mcpResourceIdentity(), epoch: randomUUID(), sequence: 0, events: [], initialized: false, snapshot: null, closed: false };
        // Install the event listener before the first snapshot to cover setup.
        channel.unwatch = runtime.watchMcpDocument(input.path, () => { void this.refresh(channel); });
        this.channels.set(key, channel);
      }
      await this.refresh(channel);
      if (!this.valid(channel) || !channel.snapshot) {
        if (![...this.subscriptions.values()].some(sub => sub.channel === channel)) { this.revoke(channel); this.channels.delete(key); }
        throw new Error("Document is unavailable for observation.");
      }
      let subscription = [...this.subscriptions.values()].find(sub => sub.owner === owner && sub.channel === channel);
      if (!subscription) {
        if (this.subscriptions.size >= 128) {
          if (![...this.subscriptions.values()].some(sub => sub.channel === channel)) { this.revoke(channel); this.channels.delete(key); }
          throw new Error("Notification subscriber limit reached. Unfollow an existing subscription.");
        }
        subscription = { id: randomUUID(), resumeToken: randomUUID(), owner, channel, ack: channel.sequence, delivered: channel.sequence, detachedAt: null };
        this.subscriptions.set(subscription.id, subscription);
      }
      return { ...this.describe(subscription), resumeToken: subscription.resumeToken, hash: channel.snapshot.hash };
    }
    if (input.action === "resume") {
      const subscription = this.subscriptions.get(input.subscriptionId);
      if (!subscription || subscription.resumeToken !== input.resumeToken) return { resyncRequired: true };
      if (scope && subscription.channel.root !== scope) throw new Error("This MCP client is restricted to its selected folder.");
      if (subscription.owner && subscription.owner !== owner) throw new Error("The notification subscription is still attached to another MCP client.");
      if (!this.valid(subscription.channel) || subscription.detachedAt !== null && this.now() - subscription.detachedAt >= this.retentionMs) {
        this.remove(subscription);
        return { resyncRequired: true };
      }
      subscription.owner = owner;
      subscription.detachedAt = null;
      subscription.resumeToken = randomUUID();
      return { ...this.describe(subscription), resumeToken: subscription.resumeToken };
    }
    if (input.action === "summary") return { subscriptions: [...this.subscriptions.values()].filter(sub => sub.owner === owner).map(sub => this.describe(sub)) };
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (!subscription || subscription.owner !== owner) throw new Error("This MCP client does not own that notification subscription.");
    const channel = subscription.channel;
    if (scope && channel.root !== scope) throw new Error("This MCP client is restricted to its selected folder.");
    if (input.action === "unfollow") { this.remove(subscription); return { unfollowed: true }; }
    if (!this.valid(channel)) { this.revoke(channel); return { resyncRequired: true }; }
    if (input.action === "ack") {
      const sequence = this.sequence(channel, input.cursor);
      if (sequence === null || sequence > subscription.delivered) throw new Error("Acknowledge a cursor returned by this subscription's list operation.");
      subscription.ack = Math.max(subscription.ack, sequence);
      return this.describe(subscription);
    }
    if (input.action !== "list") throw new Error("Unknown notification operation.");
    await this.refresh(channel);
    if (!this.valid(channel)) return { resyncRequired: true };
    const after = input.cursor === undefined ? subscription.ack : this.sequence(channel, input.cursor);
    const oldest = channel.events[0]?.sequence ?? channel.sequence + 1;
    if (after === null || after < oldest - 1) {
      // Return a boundary to acknowledge only after the caller rereads the
      // document. Never silently turn an expired cursor into an empty feed.
      subscription.delivered = channel.sequence;
      return { resyncRequired: true, cursor: this.cursor(channel), events: [] };
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Notification limit must be 1–100.");
    const events = channel.events.filter(event => event.sequence > after).slice(0, limit);
    const end = events.at(-1)?.sequence ?? after;
    subscription.delivered = Math.max(subscription.delivered, end);
    return { resyncRequired: false, events: events.map(({ sequence, ...event }) => ({ ...event, cursor: this.cursor(channel, sequence) })), cursor: this.cursor(channel, end), hasMore: end < channel.sequence };
  }

  detach(owner) {
    for (const sub of this.subscriptions.values()) if (sub.owner === owner) { sub.owner = null; sub.detachedAt = this.now(); }
  }

  remove(subscription) {
    this.subscriptions.delete(subscription.id);
    const channel = subscription.channel;
    if (![...this.subscriptions.values()].some(sub => sub.channel === channel)) {
      this.revoke(channel);
      if (this.channels.get(channel.key) === channel) this.channels.delete(channel.key);
    }
  }

  async reconcile() {
    for (const sub of this.subscriptions.values()) if (sub.detachedAt !== null && this.now() - sub.detachedAt >= this.retentionMs) this.remove(sub);
    await Promise.all([...this.channels.values()].map(channel => this.refresh(channel)));
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    const channels = [...this.channels.values()];
    for (const channel of channels) this.revoke(channel);
    await Promise.all(channels.map(channel => channel.refreshing));
    this.channels.clear();
    this.subscriptions.clear();
  }
}
