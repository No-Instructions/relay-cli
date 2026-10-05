import { commandOptions, integerOption } from "./command-options.js";
import { identityName } from "./mcp-identity.js";

export async function agentCommand(argv, getDirectory) {
  const [action, ...rest] = argv;
  const values = { create: ["name"], list: ["page", "limit"], show: [] }[action];
  if (!values) throw new Error("Use relay agent <create|list|show> --help.");
  const { options, positional } = commandOptions(rest, [...values, "state-dir"], ["json"]);
  if (positional.length !== (action === "show" ? 1 : 0)) throw new Error(`Invalid arguments. Run relay agent ${action} --help.`);
  const name = action === "create" ? identityName(options.name) : undefined;
  if (action === "show" && !/^[a-z0-9]{15}$/.test(positional[0])) throw new Error("Expected a 15-character user_agents record ID.");
  const page = integerOption(options.page, 1, 1), limit = integerOption(options.limit, 100, 1, 200);
  const directory = await getDirectory(options["state-dir"]);
  const result = action === "create" ? await directory.create(name)
    : action === "show" ? { agent: await directory.resolve({ id: positional[0] }) } : await directory.list(page, limit);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.agent) {
    console.log(`${result.agent.name}\t${result.agent.id}\nAvatar: ${result.agent.picture}`);
    if (action === "create") console.log(`${result.created ? "Created" : "Reused"} user_agents record. Use --agent ${result.agent.id} with relay mcp or relay mcp install.`);
  } else {
    for (const agent of result.agents) console.log(`${agent.id}\t${agent.name}`);
    if (result.nextPage !== null) console.error(`Next page: --page ${result.nextPage}`);
  }
}
