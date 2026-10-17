import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { buildProductCli } from "../src/product-builder.ts";
import {
	createProfileCapture,
	finalizeProfileCapture,
	formatProfileReport,
} from "../src/profile-artifact.ts";
import type { PreparedProfile } from "../src/profile-artifact.ts";

const HELP = `Usage: node scripts/profile-product-cli.ts [--compiler] [--runs N] [--cwd DIR] -- <cli arguments>

Build an instrumented development product CLI under .cache/profile-product-cli, and
profile one of its commands, such as \`-- --version\` or \`-- test app.test.mts\`.
Sampling mode records stacks; --compiler records exact source-site counters. The
command runs --runs times (default 1) and the last capture is reported.
`;

const separator = process.argv.indexOf("--");
const options = process.argv.slice(2, separator < 0 ? undefined : separator);
const cliArguments = separator < 0 ? [] : process.argv.slice(separator + 1);
if (options.includes("--help") || cliArguments.length === 0) {
	console.log(HELP);
	process.exit(cliArguments.length === 0 && !options.includes("--help") ? 1 : 0);
}
const mode: PreparedProfile["mode"] = options.includes("--compiler")
	? "compiler"
	: "sampling";
const runsIndex = options.indexOf("--runs");
const runs = runsIndex < 0 ? 1 : Number(options[runsIndex + 1]);
const cwdIndex = options.indexOf("--cwd");
const cwd = cwdIndex < 0 ? process.cwd() : path.resolve(options[cwdIndex + 1]!);
if (!Number.isSafeInteger(runs) || runs < 1)
	throw new Error("--runs must be a positive integer");

const repositoryRoot = path.resolve(import.meta.dirname, "..");
// Exact site counters are compiled in only when the native build sees this flag.
if (mode === "compiler") process.env.MAL_PERF_STATS = "1";
const outDir = path.join(repositoryRoot, ".cache", "profile-product-cli", mode);
const binary = buildProductCli({
	repositoryRoot,
	outDir,
	production: false,
	profile: mode,
	onProgress: (message) => console.error(`[build] ${message}`),
});
const prepared = JSON.parse(
	readFileSync(`${binary}.profile.json`, "utf8"),
) as PreparedProfile;
for (let run = 1; run <= runs; run++) {
	const capture = createProfileCapture(
		"product-cli",
		prepared,
		repositoryRoot,
		path.join(outDir, "captures", `${Date.now()}-${run}`),
	);
	const result = spawnSync(binary, cliArguments, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			...capture.environment,
			...(mode === "compiler" ? { MAL_PROFILE_COMPILER: "1" } : {}),
		},
	});
	if (result.error !== undefined) throw result.error;
	if (run < runs) continue;
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	const finalized = finalizeProfileCapture(capture.directory, prepared, "product-cli", {
		workloadSucceeded: result.status === 0,
	});
	console.log(`Profile ${capture.directory}`);
	for (const line of formatProfileReport(finalized)) console.log(line);
}
