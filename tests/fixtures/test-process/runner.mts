import { fileURLToPath } from "node:url";
import { runTestProcess } from "../../../scripts/test-process.ts";

const mode = process.argv[2]!;
const args =
	mode === "file-scratch"
		? [
				fileURLToPath(
					new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
				),
				"run",
				"--config",
				fileURLToPath(new URL("./scratch.config.ts", import.meta.url)),
			]
		: [fileURLToPath(new URL("./child.mts", import.meta.url)), mode];
process.exitCode = await runTestProcess(
	mode === "spawn-error" ? "/missing-maligator-test-executable" : process.execPath,
	args,
	{ environment: process.env, keepArtifacts: process.argv.includes("--keep-artifacts") },
);
