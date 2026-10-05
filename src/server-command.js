import { parseArgs } from "node:util";
import { SERVER_TREE } from "../vendor/relay-cli/server.js";

const globals = {
  help: { description: "Show help (-h)" },
  json: { description: "JSON output" },
  format: { value: "text|json", choices: ["text", "json"], description: "Output format (default: text)" },
  "state-dir": { value: "<directory>", description: "Credential state directory" },
};

export const serverRoots = SERVER_TREE.commands.map(command => command.name);

export function serverCommandHelp(argv = []) {
  const { command, path, rest } = selectCommand(argv);
  if (rest.length) throw new Error(`Unknown command: relay ${argv.join(" ")}.`);
  const lines = ["Usage: relay <command> [argument] [--option value] [--flag]", "", "Options:"];
  for (const [name, option] of Object.entries(globals)) lines.push(optionLine(name, option));
  const walk = (node, parts) => {
    lines.push("", `${parts.join(" ")}  ${node.description}`);
    for (const [name, option] of Object.entries(node.options ?? {})) {
      lines.push(optionLine(name, option, node.argument === name));
    }
    for (const child of node.commands ?? []) walk(child, [...parts, child.name]);
  };
  walk(command, path);
  return lines.join("\n");
}

function optionLine(name, option, positional = false) {
  return `  ${positional ? `${option.value} | ` : ""}--${name}${option.value ? ` ${option.value}` : ""}  ${option.description}${option.required ? " (required)" : ""}`;
}

function selectCommand(argv) {
  let command = SERVER_TREE, consumed = 0;
  const path = ["relay"];
  while (consumed < argv.length) {
    const child = command.commands?.find(candidate => candidate.name === argv[consumed]);
    if (!child) break;
    command = child;
    path.push(child.name);
    consumed++;
  }
  return { command, path, rest: argv.slice(consumed) };
}

export function parseServerCommand(argv) {
  const selected = selectCommand(argv);
  const definitions = { ...globals, ...selected.command.options };
  const { values, positionals, tokens } = parseArgs({
    args: selected.rest, strict: true, allowPositionals: true, tokens: true,
    options: Object.fromEntries(Object.entries(definitions).map(([name, option]) =>
      [name, { type: option.value ? "string" : "boolean", ...(name === "help" ? { short: "h" } : {}) }])),
  });
  const seen = new Set();
  for (const token of tokens.filter(token => token.kind === "option")) {
    if (seen.has(token.name)) throw new Error(`Give --${token.name} only once.`);
    seen.add(token.name);
  }
  if (positionals.length) {
    const name = selected.command.argument;
    if (!name || positionals.length > 1) throw new Error(`Unexpected argument: ${positionals.join(" ")}.`);
    if (Object.hasOwn(values, name)) throw new Error(`Give one ${name}: a positional argument or --${name}.`);
    values[name] = positionals[0];
  }
  if (values.json && values.format === "text") throw new Error("--json conflicts with --format text.");
  for (const [name, option] of Object.entries(definitions)) {
    const value = values[name];
    if (value === undefined) {
      if (option.required && !values.help) throw new Error(`Missing required option: --${name} ${option.value}.`);
      continue;
    }
    if (typeof value === "string") {
      values[name] = option.preserveWhitespace ? value : value.trim();
      if (!option.allowEmpty && !values[name]) throw new Error(`--${name} requires a value.`);
      if (option.choices && !option.choices.includes(values[name])) throw new Error(`--${name} must be ${option.choices.join(" or ")}.`);
    }
  }
  return { ...selected, values };
}

export async function serverCommand(argv, openAccount) {
  const { command, path, values } = parseServerCommand(argv);
  if (values.help || !command.run) {
    console.log(serverCommandHelp(path.slice(1)));
    return;
  }
  const json = values.json || values.format === "json";
  let account;
  try {
    account = await openAccount(values["state-dir"]);
    const params = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
    const result = await command.run(params, account);
    console.log(json ? JSON.stringify(Array.isArray(result.data) ? { ok: true, items: result.data } : { ok: true, ...result.data }, null, 2) : result.text);
  } catch (error) {
    if (!json) throw error;
    console.log(JSON.stringify({ ok: false, code: error.code ?? "error", message: error.message, ...error.extra }));
    process.exitCode = 1;
  } finally {
    await account?.close();
  }
}
