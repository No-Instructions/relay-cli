import http2 from "node:http2";

type Listener = (event: RelayMessageEvent) => void;

class RelayMessageEvent {
  constructor(
    public type: string,
    public data = "",
    public lastEventId = "",
  ) {}
}

export class Http2EventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = Http2EventSource.CONNECTING;
  readonly OPEN = Http2EventSource.OPEN;
  readonly CLOSED = Http2EventSource.CLOSED;

  onerror: Listener | null = null;
  onmessage: Listener | null = null;
  onopen: Listener | null = null;
  readyState = Http2EventSource.CONNECTING;

  private buffer = "";
  private currentData: string[] = [];
  private currentEvent = "message";
  private currentLastEventId = "";
  private listeners = new Map<string, Set<Listener>>();
  private request: any = null;
  private session: http2.ClientHttp2Session | null = null;

  constructor(public url: string | URL) {
    queueMicrotask(() => this.connect());
  }

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.readyState === Http2EventSource.CLOSED) return;
    this.readyState = Http2EventSource.CLOSED;
    this.closeConnection();
  }

  private closeConnection(): void {
    this.request?.removeAllListeners?.();
    this.request?.on?.("error", ignoreStreamError);
    this.request?.close?.();
    this.request?.destroy?.();
    this.session?.removeAllListeners("error");
    this.session?.on("error", ignoreStreamError);
    this.session?.close();
    this.request = null;
    this.session = null;
  }

  private connect(): void {
    if (this.readyState === Http2EventSource.CLOSED) return;
    const url = this.url instanceof URL ? this.url : new URL(String(this.url));
    if (url.protocol === "https:" || url.protocol === "http:") {
      this.connectHttp2(url);
      return;
    }
    this.fail(new Error(`Unsupported EventSource protocol: ${url.protocol}`));
  }

  private connectHttp2(url: URL): void {
    const session = http2.connect(url.origin);
    this.session = session;
    session.on("error", (error) => this.fail(error));

    const request = session.request({
      ":method": "GET",
      ":path": `${url.pathname}${url.search}`,
      accept: "text/event-stream",
      "cache-control": "no-cache",
    });
    this.request = request;
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      const status = Number(headers[":status"] ?? 0);
      if (status !== 200) {
        this.fail(new Error(`EventSource failed with status ${status}`));
        return;
      }
      this.readyState = Http2EventSource.OPEN;
      this.emit("open", new RelayMessageEvent("open"));
    });
    request.on("data", (chunk: string) => this.parse(chunk));
    request.on("end", () => {
      if (this.readyState !== Http2EventSource.CLOSED) {
        this.fail(new Error("EventSource connection ended."));
      }
    });
    request.on("error", (error: Error) => this.fail(error));
    request.end();
  }

  private parse(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.search(/\r\n|\r|\n/);
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      const separatorLength = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + separatorLength);
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    if (line === "") {
      this.dispatchCurrentEvent();
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.currentEvent = value || "message";
    } else if (field === "data") {
      this.currentData.push(value);
    } else if (field === "id") {
      this.currentLastEventId = value;
    }
  }

  private dispatchCurrentEvent(): void {
    if (this.currentData.length === 0) {
      this.currentEvent = "message";
      return;
    }
    const event = new RelayMessageEvent(
      this.currentEvent || "message",
      this.currentData.join("\n"),
      this.currentLastEventId,
    );
    this.currentData = [];
    this.currentEvent = "message";
    this.emit(event.type, event);
    if (event.type === "message") this.onmessage?.(event);
  }

  private fail(error: Error): void {
    if (this.readyState === Http2EventSource.CLOSED) return;
    this.readyState = Http2EventSource.CLOSED;
    this.closeConnection();
    this.emit("error", new RelayMessageEvent("error", error.message, this.currentLastEventId));
  }

  private emit(type: string, event: RelayMessageEvent): void {
    const propertyListener = type === "open"
      ? this.onopen
      : type === "error"
        ? this.onerror
        : null;
    propertyListener?.(event);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function ignoreStreamError() {}
