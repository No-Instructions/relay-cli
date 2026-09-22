import { Buffer } from "node:buffer";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";

const DEFAULT_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function requestBinary(input, init = {}) {
  const url = input instanceof URL ? input : new URL(String(input));
  const method = String(init.method ?? "GET").toUpperCase();
  const timeoutMs = Number(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const body = await bodyToBuffer(init.body);
  const headers = normalizeRequestHeaders(init.headers);
  if (!("user-agent" in headers)) {
    headers["user-agent"] = defaultUserAgent();
  }
  if (body && !("content-length" in headers)) {
    headers["content-length"] = String(body.byteLength);
  }

  if (url.protocol === "https:") {
    if (process.env.RELAY_HTTP_VERSION === "1.1") {
      return await requestHttp1(url, { method, headers, body, timeoutMs });
    }
    try {
      return await requestHttp2(url, { method, headers, body, timeoutMs });
    } catch (error) {
      if (!canRetryWithHttp1(error)) throw error;
      return await requestHttp1(url, { method, headers, body, timeoutMs });
    }
  }
  if (url.protocol === "http:") {
    return await requestHttp1(url, { method, headers, body, timeoutMs });
  }
  throw new Error(`Unsupported URL protocol: ${url.protocol}`);
}

export function describeNetworkError(url, description, error) {
  const details = [
    error?.cause?.code,
    error?.code,
    error?.message,
  ].filter(Boolean);
  const suffix = details.length ? ` (${[...new Set(details)].join(": ")})` : "";
  return `${description} failed: unable to reach ${url}${suffix}. Check network connectivity and that you are using the intended production or staging build.`;
}

function requestHttp2(url, input) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(url.origin);
    const chunks = [];
    let settled = false;
    let request;
    let status = 0;
    let headers = {};

    const timer = setTimeout(() => {
      const error = new Error(`Request timed out after ${input.timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      fail(error);
    }, input.timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      request?.removeAllListeners();
      request?.on("error", ignoreSessionError);
      session.removeListener("error", fail);
      session.on("error", ignoreSessionError);
      if (!session.closed && !session.destroyed) session.close();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!session.destroyed) session.destroy();
      reject(error);
    };

    session.once("error", fail);

    const requestHeaders = {
      ":method": input.method,
      ":path": `${url.pathname}${url.search}`,
      ...filterHttp2Headers(input.headers),
    };

    request = session.request(requestHeaders);
    request.once("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"] ?? 0);
      headers = normalizeResponseHeaders(responseHeaders);
    });
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(makeResponse(url, status, "", headers, Buffer.concat(chunks)));
    });
    request.once("error", fail);
    request.end(input.body ?? undefined);
  });
}

function ignoreSessionError() {}

function defaultUserAgent() {
  const navigatorUserAgent = globalThis.navigator?.userAgent;
  if (typeof navigatorUserAgent === "string" && navigatorUserAgent.trim()) {
    return navigatorUserAgent;
  }
  return "relay-cli/headless";
}

function requestHttp1(url, input) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const chunks = [];
    let settled = false;

    const request = client.request(url, {
      method: input.method,
      headers: input.headers,
    }, (response) => {
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        if (settled) return;
        settled = true;
        resolve(makeResponse(
          url,
          response.statusCode ?? 0,
          response.statusMessage ?? "",
          normalizeResponseHeaders(response.headers),
          Buffer.concat(chunks),
        ));
      });
    });

    request.setTimeout(input.timeoutMs, () => {
      const error = new Error(`Request timed out after ${input.timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });

    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end(input.body ?? undefined);
  });
}

async function bodyToBuffer(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  throw new Error(`Unsupported request body type: ${body.constructor?.name ?? typeof body}`);
}

function normalizeRequestHeaders(headers) {
  const result = {};
  if (!headers) return result;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value);
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (value != null) result[String(key).toLowerCase()] = String(value);
    }
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) result[String(key).toLowerCase()] = String(value);
  }
  return result;
}

function normalizeResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(":")) continue;
    if (value == null) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function filterHttp2Headers(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    result[key.toLowerCase()] = value;
  }
  return result;
}

function canRetryWithHttp1(error) {
  const code = error?.code ?? error?.cause?.code;
  return [
    "ECONNRESET",
    "EPROTO",
    "ERR_HTTP2_ERROR",
    "ERR_HTTP2_INVALID_SESSION",
    "ERR_HTTP2_NOT_NEGOTIATED",
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_STREAM_CANCEL",
  ].includes(code);
}

function makeResponse(url, status, statusText, headers, body) {
  return {
    url: url.toString(),
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers,
    arrayBuffer: toArrayBuffer(body),
    text: async () => body.toString("utf8"),
    json: async () => JSON.parse(body.toString("utf8")),
  };
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
