import { RelayManager } from "../../vendor/relay/src/RelayManager";
import { Settings, NamespacedSettings } from "../../vendor/relay/src/SettingsStorage";
import { EndpointManager, type EndpointSettings } from "../../vendor/relay/src/EndpointManager";
import type { LoginManager, LoginSettings } from "../../vendor/relay/src/LoginManager";
import { DefaultTimeProvider } from "../../vendor/relay/src/TimeProvider";
import { setPluginRequestConfig } from "../../vendor/relay/src/customFetch";
import { createHeadlessLoginManager } from "./HeadlessAuth";
import { readStoredLogin, updateStoredLoginToken } from "./auth-storage";

/** Account metadata access without creating a local folder or sync runtime. */
export async function openServerAccount() {
  const stored = readStoredLogin();
  if (!stored?.token) throw new Error("Not logged in. Run relay login first.");
  const timers = new DefaultTimeProvider();
  const settings = new Settings({ loadData: async () => null, saveData: async () => {} }, {
    endpoints: {} as EndpointSettings, login: { provider: undefined } as LoginSettings,
  });
  const endpoints = new NamespacedSettings(settings, "endpoints");
  const loginSettings = new NamespacedSettings(settings, "login");
  let login: LoginManager | undefined, manager: RelayManager | undefined;
  let off: (() => void) | undefined;
  const close = async () => {
    off?.();
    if (login) await login.pb.realtime.unsubscribe();
    manager?.destroy();
    login?.destroy();
    timers.destroy();
    endpoints.destroy();
    loginSettings.destroy();
    settings.destroy();
  };
  try {
    await settings.load();
    setPluginRequestConfig({ pluginId: "system3-relay" });
    const endpointManager = new EndpointManager(endpoints);
    login = await createHeadlessLoginManager("relay-account", stored.server, endpointManager, timers, loginSettings);
    if (!login.authStore.isValid) throw new Error("Login expired. Run relay login first.");
    off = login.authStore.onChange(token => {
      if (token) updateStoredLoginToken(token, endpointManager.getAuthUrl());
    });
    manager = new RelayManager(login);
    await manager.update();
    return { relayManager: manager, close };
  } catch (error) {
    await close();
    throw error;
  }
}
