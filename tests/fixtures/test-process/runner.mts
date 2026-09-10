import { fileURLToPath } from "node:url";
import { runTestProcess } from "../../../scripts/test-process.ts";

const mode = process.argv[2]!;
process.exitCode = await runTestProcess(
	mode === "spawn-error" ? "/missing-maligator-test-executable" : process.execPath,
	[fileURLToPath(new URL("./child.mts", import.meta.url)), mode],
	{ environment: process.env, keepArtifacts: process.argv.includes("--keep-artifacts") },
);
