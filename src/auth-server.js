export function normalizeAuthServer(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Relay auth server must be an HTTP(S) URL without credentials, query or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

export function assertAuthServerMatches(expected, actual) {
  if (normalizeAuthServer(expected) !== normalizeAuthServer(actual)) {
    throw new Error("Relay auth server mismatch. Use the matching production or staging build and state directory for this folder and login.");
  }
}
