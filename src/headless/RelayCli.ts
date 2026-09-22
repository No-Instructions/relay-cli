"use strict";

import type { SharedFolderSettings } from "../../vendor/relay/src/SharedFolder";
import type { HeadlessRelay } from "./HeadlessRelay";

type CliData = Record<string, string | "true">;

interface CliFlag {
	value?: string;
	description: string;
	required?: boolean;
}

type CliFlags = Record<string, CliFlag>;
type CliHandler = (params: CliData) => string | Promise<string>;

interface CliCapablePlugin {
	registerCliHandler?: (
		command: string,
		description: string,
		flags: CliFlags | null,
		handler: CliHandler,
	) => void;
}

const FORMAT_FLAG: CliFlag = {
	value: "text|json",
	description: "Output format. Defaults to text.",
};

function hasFlag(params: CliData, key: string): boolean {
	return params[key] === "true";
}

function getParam(params: CliData, key: string): string | undefined {
	const value = params[key];
	if (!value || value === "true") return undefined;
	return value;
}

function wantsJson(params: CliData): boolean {
	return getParam(params, "format") === "json";
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function boolText(value: boolean | undefined): string {
	return value === undefined ? "default" : String(value);
}

function matchingId(
	item: { id?: string; guid?: string; name?: string },
	id: string,
): boolean {
	return item.id === id || item.guid === id || item.name === id;
}

function formatBytes(value: number | undefined): string {
	if (value === undefined) return "unknown";
	if (value === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let index = 0;
	let size = value;
	while (size >= 1024 && index < units.length - 1) {
		size /= 1024;
		index += 1;
	}
	return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function serializeLogin(plugin: HeadlessRelay) {
	const endpointManager = plugin.loginManager.getEndpointManager();
	const user = plugin.loginManager.user;
	return {
		loggedIn: plugin.loginManager.loggedIn,
		user: user
			? {
					id: user.id,
					name: user.name,
					email: user.email,
				}
			: null,
		preferredProvider: plugin.loginSettings.get().provider,
		authUrl: endpointManager.getAuthUrl(),
		apiUrl: endpointManager.getApiUrl(),
	};
}

function formatLogin(data: ReturnType<typeof serializeLogin>): string {
	const lines = [
		`Relay login: ${data.loggedIn ? "logged in" : "logged out"}`,
		`Preferred provider: ${data.preferredProvider ?? "none"}`,
		`API URL: ${data.apiUrl}`,
		`Auth URL: ${data.authUrl}`,
	];
	if (data.user) {
		lines.splice(1, 0, `User: ${data.user.name || data.user.email || data.user.id}`);
	}
	return lines.join("\n");
}

async function handleLogin(plugin: HeadlessRelay, params: CliData): Promise<string> {
	const preferred = getParam(params, "preferred");
	const provider = getParam(params, "provider");

	if (hasFlag(params, "logout")) {
		plugin.loginManager.logout();
	}

	if (preferred !== undefined) {
		if (preferred === "none") {
			plugin.loginManager.clearPreferredProvider();
		} else {
			await plugin.loginSettings.set({ provider: preferred });
		}
	}

	if (provider) {
		await plugin.loginManager.login(provider);
	}

	if (hasFlag(params, "open")) {
		await plugin.openSettings();
	}

	const data = serializeLogin(plugin);
	return wantsJson(params) ? json(data) : formatLogin(data);
}

function serializeRelays(plugin: HeadlessRelay, id?: string) {
	return plugin.relayManager.relays
		.values()
		.filter((relay) => !id || matchingId(relay, id))
		.map((relay) => ({
			id: relay.id,
			guid: relay.guid,
			name: relay.name,
			role: relay.role,
			owner: relay.owner,
			version: relay.version,
			plan: relay.plan,
			cta: relay.cta,
			userLimit: relay.userLimit,
			provider: relay.provider
				? {
						id: relay.provider.id,
						name: relay.provider.name,
						url: relay.provider.url,
						selfHosted: relay.provider.selfHosted,
					}
				: null,
			storageQuota: relay.storageQuota
				? {
						id: relay.storageQuota.id,
						name: relay.storageQuota.name,
						quota: relay.storageQuota.quota,
						usage: relay.storageQuota.usage,
						maxFileSize: relay.storageQuota.maxFileSize,
						metered: relay.storageQuota.metered,
					}
				: null,
			folderCount: relay.folders.values().length,
		}));
}

function formatRelays(relays: ReturnType<typeof serializeRelays>): string {
	if (relays.length === 0) return "No relays found.";
	return relays
		.map((relay) => {
			const quota = relay.storageQuota
				? `${formatBytes(relay.storageQuota.usage)} / ${formatBytes(relay.storageQuota.quota)}`
				: "unknown quota";
			return [
				`${relay.name} (${relay.role}${relay.owner ? ", owner" : ""})`,
				`  id: ${relay.id}`,
				`  guid: ${relay.guid}`,
				`  folders: ${relay.folderCount}`,
				`  provider: ${relay.provider?.name ?? "Relay.md"}`,
				`  storage: ${quota}`,
			].join("\n");
		})
		.join("\n\n");
}

async function handleRelays(plugin: HeadlessRelay, params: CliData): Promise<string> {
	if (hasFlag(params, "refresh") && plugin.loginManager.loggedIn) {
		await plugin.relayManager.update();
	}

	const data = serializeRelays(plugin, getParam(params, "id"));
	return wantsJson(params) ? json(data) : formatRelays(data);
}

function relayMatchesFilter(
	relay: { id?: string; guid?: string; name?: string } | null | undefined,
	filter: string | undefined,
): boolean {
	if (!filter) return true;
	return !!relay && matchingId(relay, filter);
}

function serializeLocalFolders(plugin: HeadlessRelay, params: CliData) {
	const settings = plugin.settings.get() as { sharedFolders?: SharedFolderSettings[] };
	const path = getParam(params, "path");
	const guid = getParam(params, "guid");
	const relayFilter = getParam(params, "relay");

	return (settings.sharedFolders ?? [])
		.filter((folder) => !path || folder.path === path)
		.filter((folder) => !guid || folder.guid === guid)
		.map((folder) => {
			const loaded = plugin.sharedFolders.find(
				(sharedFolder) => sharedFolder.guid === folder.guid,
			);
			const remote = loaded?.remote;
			const relay = remote?.relay ?? null;
			if (
				relayFilter &&
				folder.relay !== relayFilter &&
				!relayMatchesFilter(relay, relayFilter)
			) {
				return null;
			}

			return {
				guid: folder.guid,
				path: folder.path,
				relay: folder.relay,
				connect: folder.connect,
				localOnly: folder.localOnly,
				loaded: !!loaded,
				connected: loaded?.connected ?? false,
				remote: remote
					? {
							id: remote.id,
							name: remote.name,
							private: remote.private,
							role: remote.role,
						}
					: null,
				relayRecord: relay
					? {
							id: relay.id,
							guid: relay.guid,
							name: relay.name,
						}
					: null,
				sync: folder.sync,
				remoteActivityCount: folder.remoteActivity?.length ?? 0,
			};
		})
		.filter((folder): folder is Exclude<typeof folder, null> => folder !== null);
}

function serializeRemoteFolders(plugin: HeadlessRelay, params: CliData) {
	const path = getParam(params, "path");
	const guid = getParam(params, "guid");
	const relayFilter = getParam(params, "relay");

	return plugin.relayManager.remoteFolders
		.values()
		.filter((remote) => !guid || remote.guid === guid)
		.filter((remote) => relayMatchesFilter(remote.relay, relayFilter))
		.map((remote) => {
			const local = plugin.sharedFolders.find(
				(folder) => folder.guid === remote.guid,
			);
			if (path && local?.path !== path) return null;

			return {
				id: remote.id,
				guid: remote.guid,
				name: remote.name,
				private: remote.private,
				role: remote.role,
				owner: remote.owner,
				creator: {
					id: remote.creatorId,
					name: remote.creator.name,
					email: remote.creator.email,
				},
				relay: {
					id: remote.relay.id,
					guid: remote.relay.guid,
					name: remote.relay.name,
				},
				localPath: local?.path ?? null,
				localConnected: local?.connected ?? false,
			};
		})
		.filter((folder): folder is Exclude<typeof folder, null> => folder !== null);
}

function serializeFolders(plugin: HeadlessRelay, params: CliData) {
	const scope = getParam(params, "scope") ?? "all";
	return {
		local: scope === "remote" ? [] : serializeLocalFolders(plugin, params),
		remote: scope === "local" ? [] : serializeRemoteFolders(plugin, params),
	};
}

function formatFolders(data: ReturnType<typeof serializeFolders>): string {
	const lines: string[] = [];

	if (data.local.length > 0) {
		lines.push("Local folders");
		for (const folder of data.local) {
			lines.push(
				[
					`- ${folder.path}`,
					`  guid: ${folder.guid}`,
					`  relay: ${folder.relayRecord?.name ?? folder.relay ?? "none"}`,
					`  connect: ${boolText(folder.connect)}`,
					`  localOnly: ${boolText(folder.localOnly)}`,
					`  loaded: ${folder.loaded}`,
					`  connected: ${folder.connected}`,
				].join("\n"),
			);
		}
	}

	if (data.remote.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Remote folders");
		for (const folder of data.remote) {
			lines.push(
				[
					`- ${folder.name}`,
					`  id: ${folder.id}`,
					`  guid: ${folder.guid}`,
					`  relay: ${folder.relay.name}`,
					`  role: ${folder.role}`,
					`  private: ${folder.private}`,
					`  localPath: ${folder.localPath ?? "not added"}`,
				].join("\n"),
			);
		}
	}

	if (lines.length === 0) return "No folders found.";
	return lines.join("\n");
}

async function handleFolders(plugin: HeadlessRelay, params: CliData): Promise<string> {
	if (hasFlag(params, "refresh") && plugin.loginManager.loggedIn) {
		await plugin.relayManager.update();
	}

	const data = serializeFolders(plugin, params);
	return wantsJson(params) ? json(data) : formatFolders(data);
}

function serializeSettings(plugin: HeadlessRelay, params: CliData) {
	const settings = plugin.settings.get() as unknown as Record<string, unknown>;
	const requestedSection = getParam(params, "section") ?? "all";
	const section =
		requestedSection === "folders" ? "sharedFolders" : requestedSection;
	const featureFlags = Object.fromEntries(
		Object.entries(settings).filter(([key]) => key.startsWith("enable")),
	);
	const data: Record<string, unknown> = {
		login: settings.login ?? {},
		sharedFolders: settings.sharedFolders ?? [],
		endpoints: settings.endpoints ?? {},
		release: settings.release ?? {},
		debugging: settings.debugging ?? false,
		featureFlags,
	};

	if (section === "all") return data;
	return { [section]: data[section] ?? null };
}

function formatSettings(data: Record<string, unknown>): string {
	return json(data);
}

function handleSettings(plugin: HeadlessRelay, params: CliData): string {
	const data = serializeSettings(plugin, params);
	return wantsJson(params) ? json(data) : formatSettings(data);
}

export function registerRelayCliHandlers(plugin: HeadlessRelay): void {
	const register = (plugin as unknown as CliCapablePlugin).registerCliHandler;
	if (!register) {
		plugin.debug("Obsidian CLI handler API is not available");
		return;
	}

	register.call(
		plugin,
		"relay:login",
		"Show or update Relay login state for this vault.",
		{
			format: FORMAT_FLAG,
			provider: {
				value: "provider",
				description: "Start OAuth login with the named provider.",
			},
			preferred: {
				value: "provider|none",
				description: "Set the preferred login provider without starting OAuth.",
			},
			logout: {
				description: "Log out of Relay.",
			},
			open: {
				description: "Open Relay settings.",
			},
		},
		(params) => handleLogin(plugin, params),
	);

	register.call(
		plugin,
		"relay:relays",
		"List Relay servers available to this account.",
		{
			format: FORMAT_FLAG,
			refresh: {
				description: "Refresh Relay account data before listing.",
			},
			id: {
				value: "id|guid|name",
				description: "Filter to a single relay.",
			},
		},
		(params) => handleRelays(plugin, params),
	);

	register.call(
		plugin,
		"relay:folders",
		"List local and remote Relay folders for this vault.",
		{
			format: FORMAT_FLAG,
			refresh: {
				description: "Refresh Relay account data before listing.",
			},
			scope: {
				value: "all|local|remote",
				description: "Choose which folders to show. Defaults to all.",
			},
			path: {
				value: "path",
				description: "Filter by local vault path.",
			},
			guid: {
				value: "guid",
				description: "Filter by folder GUID.",
			},
			relay: {
				value: "id|guid|name",
				description: "Filter by relay.",
			},
		},
		(params) => handleFolders(plugin, params),
	);

	register.call(
		plugin,
		"relay:settings",
		"Show Relay plugin settings for this vault.",
		{
			format: FORMAT_FLAG,
			section: {
				value: "all|login|folders|sharedFolders|endpoints|release|debugging|featureFlags",
				description: "Settings section to show. Defaults to all.",
			},
		},
		(params) => handleSettings(plugin, params),
	);
}
