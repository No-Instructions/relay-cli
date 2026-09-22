declare const RELAY_BUILD_TARGET: "production" | "staging";
declare const AUTH_URL: string;
declare const API_URL: string;

// CLI login and the sync runtime share the configuration baked into this bundle.
export const buildConfig = Object.freeze({
  target: RELAY_BUILD_TARGET,
  authUrl: AUTH_URL,
  apiUrl: API_URL,
});
