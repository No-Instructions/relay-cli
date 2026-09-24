// Replaced at compile time. Source checkouts remain runnable with Node or Bun.
export const embeddedRelease = typeof RMD_RELEASE_METADATA === "undefined" ? null : RMD_RELEASE_METADATA;

export function cliInvocation(args) {
  return embeddedRelease ? args : [process.argv[1], ...args];
}
