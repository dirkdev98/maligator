import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { compileEntrypointToBuffer } from "../src/compiler/pipeline/compile-program.ts";
import { resolvePathExecutable } from "../src/rust-build.ts";
import { buildNativeBinary } from "../src/test-harness.ts";

const root = path.resolve(".cache/selfhost-native");
const tools = path.join(root, "tools");
const fixture = path.resolve("tests/fixtures/selfhost-native/entry.mts");
const progress = new CommandProgress("selfhost-native");
progress.start("isolate tools, build the compiler, and compare native outputs");
rmSync(root, { recursive: true, force: true });
mkdirSync(tools, { recursive: true });

const originalPath = process.env.PATH ?? "";
const required = ["cc", "ar", "rustup", "cargo"];
const optional = ["c++", "clang", "ranlib", "make", "ninja", "vm_stat"];
const rustup = resolvePathExecutable("rustup", originalPath);
for (const name of [...required, ...optional]) {
	let source: string;
	try {
		source =
			name === "cargo"
				? execFileSync(rustup, ["which", "cargo"], {
						cwd: "runtime/rust",
						encoding: "utf-8",
					}).trim()
				: resolvePathExecutable(name, originalPath);
	} catch (error) {
		if (required.includes(name)) throw error;
		continue;
	}
	symlinkSync(source, path.join(tools, name));
}

const isolatedEnv = { ...process.env, PATH: tools };
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

function run(binary: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(binary, [], { encoding: "utf-8", timeout: 20000 });
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

const prebuiltWire = path.join(root, "compiler.malw");
writeFileSync(
	prebuiltWire,
	compileEntrypointToBuffer(
		path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
		{
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
progress.complete();
