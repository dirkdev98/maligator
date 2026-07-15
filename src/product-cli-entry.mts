import { runCli } from "./cli-commands.ts";
import { stripCompactTypes } from "./compact-type-strip.ts";

runCli(process.argv.slice(2), { stripTypes: stripCompactTypes });
