import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";
import { resolvePathExecutable } from "../src/rust-build.ts";
import {
	SELFHOST_NATIVE_EMISSION,
	SELFHOST_NATIVE_FRONTEND,
	selfhostNativeEvidence,
	selfhostNativeTargetConfig,
} from "../src/selfhost-native-target.ts";
import { buildNativeBinary, STRESS_ENV } from "../src/test-harness.ts";

const root = path.join(
	maligatorCacheDirectory(),
	"work",
	"selfhost-native",
	String(process.pid),
);
const tools = path.join(root, "tools");
const fixture = path.resolve("tests/fixtures/selfhost-native/entry.mts");
// Wide private roots, shared slots, collecting getters, exceptions and suspension.
const storageFixture = path.resolve("tests/fixtures/selfhost-native/storage.mts");
const progress = new CommandProgress("selfhost-native");
progress.start("isolate tools, build the compiler, and compare native outputs");
rmSync(root, { recursive: true, force: true });
mkdirSync(tools, { recursive: true });

const originalPath = process.env.PATH ?? "";
const required = ["cc", "ar", "ld", "rustup", "cargo"];
const optional = ["c++", "clang", "ranlib", "make", "ninja", "vm_stat"];
const rustup = resolvePathExecutable("rustup", originalPath);
for (const name of [...required, ...optional]) {
	const executable =
		name === "cc"
			? process.env.CC?.trim() || name
			: name === "c++"
				? process.env.CXX?.trim() || name
				: name;
	let source: string;
	try {
		source =
			name === "cargo"
				? execFileSync(rustup, ["which", "cargo"], {
						cwd: "runtime/rust",
						encoding: "utf-8",
					}).trim()
				: executable.includes(path.sep)
					? executable
					: resolvePathExecutable(executable, originalPath);
	} catch (error) {
		if (required.includes(name)) throw error;
		continue;
	}
	symlinkSync(source, path.join(tools, name));
}

const isolatedEnv = {
	...process.env,
	PATH: tools,
	CC: path.join(tools, "cc"),
	CXX: path.join(tools, "c++"),
};
let nodeResolved = true;
try {
	execFileSync("node", ["--version"], { env: isolatedEnv, stdio: "ignore" });
} catch (error) {
	nodeResolved = (error as { code?: string }).code !== "ENOENT";
}
if (nodeResolved)
	throw new Error(`node unexpectedly resolves on isolated PATH: ${tools}`);
console.log(`ok   node does not resolve on isolated PATH (${tools})`);

const compilerConfig = resolveBuildConfig({
	engine: { eval: false, regexp: true, intl: { enabled: false } },
	surface: { webPlatform: false, node: true },
});
const compiler = buildNativeBinary({
	fixture: "src/selfhost-native-entry.mts",
	name: "selfhost-native-compiler",
	outDir: root,
	config: compilerConfig,
});

const targetConfig = resolveBuildConfig({
	engine: { eval: false, regexp: false, intl: { enabled: false } },
	surface: { webPlatform: false, node: false },
});
const reference = buildNativeBinary({
	fixture,
	name: "node-reference",
	outDir: root,
	config: targetConfig,
});

const nativeOutput = execFileSync(compiler, [fixture, "native-output", root], {
	env: isolatedEnv,
	encoding: "utf-8",
	stdio: ["ignore", "pipe", "inherit"],
	timeout: 180000,
}).trim();

function run(
	binary: string,
	args: ReadonlyArray<string> = [],
	env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(binary, args, {
		encoding: "utf-8",
		timeout: 120000,
		...(env === undefined ? {} : { env: { ...process.env, ...env } }),
	});
	if (result.error !== undefined) throw result.error;
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const expected = run(reference);
const actual = run(nativeOutput);
if (
	actual.status !== expected.status ||
	actual.stdout !== expected.stdout ||
	actual.stderr !== expected.stderr
) {
	throw new Error(
		`self-host native mismatch\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`,
	);
}
console.log(
	`ok   self-hosted compiler linked and ran fixture (exit ${actual.status}, stdout ${JSON.stringify(actual.stdout.trim())})`,
);

for (const input of [fixture, storageFixture]) {
	const name = path.basename(input, ".mts");
	const evidence = path.join(root, "evidence", name);
	const binary = execFileSync(
		compiler,
		[input, `selfhost-${name}`, root, "--evidence", evidence],
		{
			env: isolatedEnv,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "inherit"],
			timeout: 180000,
		},
	).trim();
	const definition = compileEntrypoint(input, {
		...SELFHOST_NATIVE_FRONTEND,
		buildConfig: selfhostNativeTargetConfig(false),
	});
	const expectedFiles = selfhostNativeEvidence(
		definition,
		emitProgramTranslationUnits(definition, SELFHOST_NATIVE_EMISSION),
	);
	const actualNames = readdirSync(evidence).sort();
	const expectedNames = expectedFiles.map((file) => file.name).sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
		throw new Error(
			`${name}: self-hosted evidence files ${JSON.stringify(actualNames)} != Node ${JSON.stringify(expectedNames)}`,
		);
	for (const file of expectedFiles) {
		if (!readFileSync(path.join(evidence, file.name)).equals(Buffer.from(file.bytes)))
			throw new Error(
				`${name}: self-hosted ${file.name} differs from the Node-hosted compiler`,
			);
	}
	const oracle = run(process.execPath, [input]);
	for (const [mode, env] of [
		["normal", {}],
		["GC stress", { ...STRESS_ENV, MAL_HOST_GC: "1" }],
	] as const) {
		const result = run(binary, [], env);
		if (
			result.status !== oracle.status ||
			result.stdout !== oracle.stdout ||
			result.stderr !== oracle.stderr
		)
			throw new Error(
				`${name}: self-hosted output under ${mode} differs\nexpected ${JSON.stringify(oracle)}\nactual   ${JSON.stringify(result)}`,
			);
	}
	console.log(
		`ok   ${name}: native plans and ${expectedFiles.length - 2} C units match Node; output matches under GC stress`,
	);
}

const prebuiltWire = path.join(root, "compiler.malw");
writeFileSync(
	prebuiltWire,
	compileEntrypointToBuffer(
		path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
		{
			intrinsicGlobalReads: true,
			stripTypes: stripCompactTypes,
		},
	),
);
const evalConfig = resolveBuildConfig({
	engine: { eval: true, regexp: false, intl: { enabled: false } },
	surface: { webPlatform: false, node: false },
});
const evalReference = buildNativeBinary({
	fixture,
	name: "node-reference-eval",
	outDir: root,
	config: evalConfig,
	compilerBake: { kind: "prebuilt", path: prebuiltWire },
});
const evalOutput = execFileSync(
	compiler,
	[fixture, "native-output", root, prebuiltWire],
	{
		env: isolatedEnv,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "inherit"],
		timeout: 180000,
	},
).trim();
const evalActual = run(evalOutput);
const evalExpected = run(evalReference);
if (
	evalActual.status !== evalExpected.status ||
	evalActual.stdout !== evalExpected.stdout ||
	evalActual.stderr !== evalExpected.stderr
) {
	throw new Error(
		`self-host eval mismatch\nexpected ${JSON.stringify(evalExpected)}\nactual   ${JSON.stringify(evalActual)}`,
	);
}
console.log(`ok   eval-enabled self-host build consumed explicit prebuilt compiler wire`);
// Failures exit above and keep this directory for diagnosis.
rmSync(root, { recursive: true, force: true });
progress.complete();
