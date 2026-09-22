#!/usr/bin/env -S node --no-warnings

import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});
