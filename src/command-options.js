export function commandOptions(argv, values, booleans = []) {
  const options = {}, positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") { positional.push(...argv.slice(index + 1)); break; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}.`);
    if (booleans.includes(key) && equals < 0) options[key] = true;
    else if (values.includes(key)) {
      const value = equals < 0 ? argv[++index] : arg.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value.`);
      options[key] = value;
    } else throw new Error(`Unknown option ${arg}. Run this command with --help.`);
  }
  return { options, positional };
}

export function integerOption(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`Expected an integer from ${min} to ${max}.`);
  return Number(value);
}
