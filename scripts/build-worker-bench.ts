import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Configuration from "../src/build-config.ts";
import type * as Harness from "../src/test-harness.ts";

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (sourceArgument === undefined || outputArgument === undefined)
	throw new Error(
		"Usage: node scripts/build-worker-bench.ts SOURCE_ROOT OUTPUT_DIRECTORY",
	);
const root = path.resolve(sourceArgument);
const output = path.resolve(outputArgument);
const benchmarks = path.resolve(import.meta.dirname, "../bench/workers");
mkdirSync(output, { recursive: true });

function sourceIdentity() {
	const files = execFileSync(
		"rg",
		["--files", "src", "runtime", "package.json", "package-lock.json"],
		{
			cwd: root,
			encoding: "utf8",
		},
	)
		.trim()
		.split("\n")
		.sort();
	const sources = files.map((file) => [
		file,
		hash("sha256", readFileSync(path.join(root, file)), "hex"),
	]);
	return { digest: hash("sha256", JSON.stringify(sources), "hex"), sources };
}

const source = sourceIdentity();
const inputs = [
	...readdirSync(benchmarks).filter((file) => /\.(?:c|mjs)$/.test(file)),
	"../../tests/local/fibertest_stub.js",
]
	.sort()
	.map((file) => ({
		file,
		sha256: hash("sha256", readFileSync(path.join(benchmarks, file)), "hex"),
	}));
writeFileSync(
	path.join(output, "source-identity.json"),
	`${JSON.stringify({ root, ...source, inputs }, null, 2)}\n`,
);
process.chdir(root);
const harness = (await import(
	pathToFileURL(path.join(root, "src/test-harness.ts")).href
)) as typeof Harness;
const configuration = (await import(
	pathToFileURL(path.join(root, "src/build-config.ts")).href
)) as typeof Configuration;
const config = configuration.resolveBuildConfig({
	surface: { node: true },
	engine: { primordials: "locked" },
});
for (const name of [
	"tinypool",
	"pool",
	"channels",
	"gc-process",
	"memory-usage",
	"serial",
]) {
	const before = performance.now();
	const build: Harness.BuildNativeBinaryResult = harness.buildNativeBinaryResult({
		fixture:
			name === "gc-process"
				? path.resolve(benchmarks, "../../tests/local/fibertest_stub.js")
				: path.join(benchmarks, `${name}.mjs`),
		name,
		outDir: output,
		config,
		production: true,
		...(name === "gc-process" ? { mainFile: path.join(benchmarks, "gc-process.c") } : {}),
	});
	const identity = {
		binaryPath: build.binaryPath,
		buildMs: performance.now() - before,
		executableBytes: statSync(build.binaryPath).size,
		sha256: hash("sha256", readFileSync(build.binaryPath), "hex"),
		sourceDigest: source.digest,
		inputs,
		config,
		toolchain: build.context.toolchain.fingerprint,
		target: build.context.toolchain.target,
		features: build.context.features,
		environmentFingerprint: build.context.environmentFingerprint,
		plan: build.context.plan,
	};
	writeFileSync(
		path.join(output, `${name}.json`),
		`${JSON.stringify(identity, null, 2)}\n`,
	);
	console.log(
		JSON.stringify({ name, binaryPath: identity.binaryPath, buildMs: identity.buildMs }),
	);
}
if (sourceIdentity().digest !== source.digest)
	throw new Error(
		"Source changed during benchmark build; these binaries are not a matched set",
	);
console.log(`Worker benchmark binaries and identities: ${output}`);
