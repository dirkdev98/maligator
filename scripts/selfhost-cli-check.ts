import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { buildProductCli } from "../src/product-builder.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(
	maligatorCacheDirectory(),
	"work",
	"selfhost-cli",
	String(process.pid),
);
const tools = path.join(root, "tools");
const project = path.join(root, "isolated-project");
const distribution = path.join(root, "distribution");
const noTools = path.join(root, "no-tools");
const configPath = path.join(project, "maligator.build.ts");
const developmentConfigPath = path.join(project, "maligator.development.build.ts");
const expressFixturePath = "tests/fixtures/express-5";
const expressConfigPath = `${expressFixturePath}/assets-app.build.mts`;
const expressTestPath = `${expressFixturePath}/assets-app.test.mjs`;
const fixture = "entry.mts";
const originalPath = process.env.PATH ?? "";
const progress = new CommandProgress("selfhost-cli");
progress.start("build and exercise the isolated product CLI");

if (spawnSync(process.execPath, ["--version"]).status !== 0) {
	throw new Error("the Node-hosted bootstrap is unavailable");
}
rmSync(root, { recursive: true, force: true });
mkdirSync(tools, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(distribution, { recursive: true });
mkdirSync(noTools, { recursive: true });
cpSync(
	path.join(repositoryRoot, expressFixturePath),
	path.join(project, expressFixturePath),
	{ recursive: true },
);

const rustup = resolvePathExecutable("rustup", originalPath);
const selectedCargo = execFileSync(rustup, ["which", "cargo"], {
	cwd: path.join(repositoryRoot, "runtime/rust"),
	encoding: "utf-8",
}).trim();
const selectedRustc = execFileSync(rustup, ["which", "rustc"], {
	cwd: path.join(repositoryRoot, "runtime/rust"),
	encoding: "utf-8",
}).trim();
const requestedTools: Array<[string, string, boolean]> = [
	["cc", process.env.CC?.trim() || "cc", true],
	["c++", process.env.CXX?.trim() || "c++", true],
	["ar", "ar", true],
	["ld", "ld", true],
	["rustup", rustup, true],
	["cargo", selectedCargo, true],
	["rustc", selectedRustc, true],
	["strip", "strip", false],
	["make", "make", false],
	["ninja", "ninja", false],
	["ranlib", "ranlib", false],
];
for (const [name, executable, required] of requestedTools) {
	let source: string;
	try {
		source = executable.includes(path.sep)
			? executable
			: resolvePathExecutable(executable, originalPath);
	} catch (error) {
		if (required) throw error;
		continue;
	}
	symlinkSync(source, path.join(tools, name));
}

const isolatedEnv = {
	...process.env,
	PATH: tools,
	CC: path.join(tools, "cc"),
	CXX: path.join(tools, "c++"),
	SELFHOST_CLI_NODE: "1",
};
const testOnlyEnv = {
	PATH: noTools,
	CC: path.join(noTools, "unavailable-cc"),
	CXX: path.join(noTools, "unavailable-cxx"),
};
const missingNode = spawnSync("node", ["--version"], { env: isolatedEnv });
if (
	missingNode.error === undefined ||
	(missingNode.error as NodeJS.ErrnoException).code !== "ENOENT"
) {
	throw new Error(`node unexpectedly resolves on isolated PATH: ${tools}`);
}
console.log(`ok   node does not resolve on isolated PATH (${tools})`);

const cli = buildProductCli({
	repositoryRoot,
	outDir: root,
	onProgress: (message) => console.log(`step ${message}`),
});
const distributedCli = path.join(distribution, "maligator");
copyFileSync(cli, distributedCli);
chmodSync(distributedCli, 0o755);
console.log(`ok   compiled self-contained product CLI (${distributedCli})`);

function invokeCaptured(args: Array<string>, envOverrides: Record<string, string> = {}) {
	const result = spawnSync(distributedCli, args, {
		cwd: project,
		env: { ...isolatedEnv, ...envOverrides },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	return result;
}

function invoke(args: Array<string>, envOverrides: Record<string, string> = {}): string {
	const result = invokeCaptured(args, envOverrides);
	if (result.signal !== null || result.status !== 0) {
		throw new Error(
			`maligator ${args.join(" ")} ${
				result.signal ? `received ${result.signal}` : `exited with ${result.status}`
			}:\n${result.stdout}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

function invokeFailure(
	args: Array<string>,
	envOverrides: Record<string, string> = {},
): string {
	const result = invokeCaptured(args, envOverrides);
	if (result.signal !== null) {
		throw new Error(
			`failing command received ${result.signal}: maligator ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
		);
	}
	if (result.status === 0) {
		throw new Error(`command unexpectedly succeeded: maligator ${args.join(" ")}`);
	}
	return `${result.stdout}\n${result.stderr}`;
}

async function waitForOutput(
	read: () => string,
	expected: string,
	timeoutMs = 10_000,
): Promise<void> {
	const startedAt = Date.now();
	while (!read().includes(expected)) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`timed out waiting for ${JSON.stringify(expected)}:\n${read()}`);
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
	}
}

if (existsSync(configPath)) {
	throw new Error(`integration refuses to overwrite existing ${configPath}`);
}
let createdConfig = false;
try {
	const initOutput = invoke(["init"]);
	createdConfig = true;
	if (!initOutput.includes("Created") || !initOutput.includes(configPath)) {
		throw new Error(`init output was not actionable:\n${initOutput}`);
	}
	console.log("ok   init created maligator.build.ts");

	writeFileSync(
		configPath,
		`import { defineBuild } from "@maligator/cli";\n\nconst nodeSurface: boolean = process.env.SELFHOST_CLI_NODE === "1";\nexport default defineBuild({\n\tentry: ${JSON.stringify(fixture)},\n\toutputName: "selfhost-cli-app",\n\tassets: { payload: { type: "file", path: "payload.bin" } },\n\tengine: { eval: true, regexp: false, intl: { enabled: false } },\n\tsurface: { webPlatform: false, node: nodeSurface, maligator: true },\n});\n`,
	);
	writeFileSync(
		path.join(project, "payload.bin"),
		new Uint8Array([0, 0xff, 0xc3, 0x28, 65]),
	);
	writeFileSync(
		path.join(project, "helper.ts"),
		`export interface HelperValue { readonly label: string }\nconst helperDefault: HelperValue = { label: "compact" };\nexport default helperDefault;\nexport const ok = <const ValueType>(value: ValueType) => ({ value });\n`,
	);
	writeFileSync(
		path.join(project, fixture),
		`import { readFileSync } from "node:fs";\nimport helperDefault, { ok, type HelperValue } from "./helper.ts";\n\nconst expected = [0, 255, 195, 40, 65];\nconst payload = readFileSync(globalThis.mal.assets.materialize("payload"));\nif (payload.length !== expected.length || payload.some((value, index) => value !== expected[index])) process.exit(18);\nif (eval("20 + 22") !== 42) process.exit(19);\nconst genericResult: { value: HelperValue } = ok(helperDefault);\nif (genericResult.value.label !== "compact") process.exit(20);\nconst actual = process.argv.slice(2);\nconsole.log(\`selfhost-cli \${actual.join("|")}\`);\n`,
	);
	writeFileSync(
		developmentConfigPath,
		`export default {
	entry: "development.mts",
	surface: { webPlatform: true, node: true },
};
`,
	);
	writeFileSync(
		path.join(project, "development.mts"),
		`import { basename } from "node:path";
const expected = process.argv.slice(2).join("|");
setTimeout(() => {
	console.log(\`toolchain-free \${basename("/one/two.ts")} \${new URL("https://example.test/path").hostname} \${expected}\`);
}, 0);
`,
	);
	const developmentOutput = invoke(
		["run", "--config", developmentConfigPath, "--", "alpha", "two words"],
		testOnlyEnv,
	);
	if (!developmentOutput.includes("toolchain-free two.ts example.test alpha|two words")) {
		throw new Error(`toolchain-free development run failed:\n${developmentOutput}`);
	}
	console.log("ok   packaged CLI ran Node and Web development code without a toolchain");

	const watchEntry = path.join(project, "watch.mts");
	const watchSource = (revision: number) =>
		`console.log("watch revision ${revision}");\nsetInterval(() => {}, 1000);\n`;
	writeFileSync(watchEntry, watchSource(0));
	const watcher = spawn(
		distributedCli,
		["dev", watchEntry, "--config", developmentConfigPath],
		{
			cwd: project,
			env: { ...isolatedEnv, ...testOnlyEnv },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let watchOutput = "";
	watcher.stdout.setEncoding("utf-8");
	watcher.stderr.setEncoding("utf-8");
	watcher.stdout.on("data", (chunk: string) => {
		watchOutput += chunk;
	});
	watcher.stderr.on("data", (chunk: string) => {
		watchOutput += chunk;
	});
	await waitForOutput(() => watchOutput, "watch revision 0");
	writeFileSync(watchEntry, watchSource(1));
	await waitForOutput(() => watchOutput, "watch revision 1");
	watcher.kill("SIGTERM");
	const watchExit = await new Promise<number | null>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`watcher did not stop:\n${watchOutput}`)),
			5000,
		);
		watcher.once("exit", (code) => {
			clearTimeout(timeout);
			resolve(code);
		});
	});
	if (watchExit !== 0) {
		throw new Error(`watcher exited with ${watchExit}:\n${watchOutput}`);
	}
	console.log("ok   development watcher rebuilt and restarted without a toolchain");

	const doctorOutput = invoke(["doctor", "--verbose"]);
	if (!doctorOutput.includes("Toolchain is ready.")) {
		throw new Error(`doctor did not accept the isolated toolchain:\n${doctorOutput}`);
	}
	console.log("ok   doctor found the isolated native toolchain");

	const buildOutput = invoke(["build", "--verbose"]);
	if (!buildOutput.includes("selfhost-cli-app") || buildOutput.trim().includes("\n")) {
		throw new Error(`build did not report its output:\n${buildOutput}`);
	}
	console.log("ok   distributed compiler built the configured application");
	const cachedBuild = spawnSync(distributedCli, ["build", "--verbose"], {
		cwd: project,
		env: isolatedEnv,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (
		cachedBuild.status !== 0 ||
		cachedBuild.stdout !== buildOutput ||
		!cachedBuild.stderr.includes("Binary cache: hit")
	) {
		throw new Error(
			`cached build did not restore the linked binary:\n${cachedBuild.stdout}\n${cachedBuild.stderr}`,
		);
	}
	console.log("ok   distributed compiler restored the cached linked binary");

	const runOutput = invoke(["run", "--", "alpha", "two words", "--flag"]);
	if (!runOutput.includes("selfhost-cli alpha|two words|--flag")) {
		throw new Error(`run did not forward arguments:\n${runOutput}`);
	}
	console.log(
		"ok   target materialized binary assets, executed eval, and forwarded arguments",
	);

	const expressRunOutput = invoke(["run", "--config", expressConfigPath]);
	if (!expressRunOutput.includes("EXPRESS_ASSETS_SMOKE static payload")) {
		throw new Error(
			`Express asset run did not complete its HTTP checks:\n${expressRunOutput}`,
		);
	}
	console.log("ok   run served Express routes from an external Mal asset snapshot");

	const expressWatcher = spawn(
		distributedCli,
		["dev", "--config", expressConfigPath, "--", "--serve"],
		{
			cwd: project,
			env: isolatedEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let expressWatchOutput = "";
	expressWatcher.stdout.setEncoding("utf-8");
	expressWatcher.stderr.setEncoding("utf-8");
	expressWatcher.stdout.on("data", (chunk: string) => {
		expressWatchOutput += chunk;
	});
	expressWatcher.stderr.on("data", (chunk: string) => {
		expressWatchOutput += chunk;
	});
	const expressWatcherExit = new Promise<number | null>((resolve) => {
		expressWatcher.once("exit", (code) => resolve(code));
	});
	const isolatedPublicAsset = path.join(project, expressFixturePath, "public/hello.txt");
	let expressWatchExit: number | null | undefined;
	const expressOrigins = () =>
		[
			...expressWatchOutput.matchAll(/EXPRESS_ASSETS_READY (http:\/\/127\.0\.0\.1:\d+)/g),
		].map((match) => match[1]!);
	const expectAsset = async (expected: string) => {
		const origins = expressOrigins();
		const origin = origins.at(-1);
		if (origin === undefined)
			throw new Error(`Express dev server did not publish an origin`);
		const response = await fetch(`${origin}/assets/hello.txt`);
		if (response.status !== 200 || (await response.text()) !== expected) {
			throw new Error(`Express dev server did not serve ${JSON.stringify(expected)}`);
		}
	};
	try {
		await waitForOutput(() => expressWatchOutput, "EXPRESS_ASSETS_READY", 60_000);
		await expectAsset("static payload\n");
		writeFileSync(isolatedPublicAsset, "static payload updated\n");
		await waitForOutput(
			() => (expressOrigins().length >= 2 ? "EXPRESS_ASSETS_RESTARTED" : ""),
			"EXPRESS_ASSETS_RESTARTED",
			60_000,
		);
		await expectAsset("static payload updated\n");
	} finally {
		expressWatcher.kill("SIGTERM");
		expressWatchExit = await new Promise<number | null>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Express watcher did not stop:\n${expressWatchOutput}`)),
				5000,
			);
			void expressWatcherExit.then((code) => {
				clearTimeout(timeout);
				resolve(code);
			});
		});
		copyFileSync(
			path.join(repositoryRoot, expressFixturePath, "public/hello.txt"),
			isolatedPublicAsset,
		);
	}
	if (expressWatchExit !== 0) {
		throw new Error(
			`Express watcher exited with ${expressWatchExit}:\n${expressWatchOutput}`,
		);
	}
	console.log("ok   dev rebuilt Express after a configured asset edit");

	const expressBuildOutput = invoke(["build", "--config", expressConfigPath]);
	const expressBinary = path.resolve(project, expressBuildOutput.trim());
	if (!existsSync(expressBinary)) {
		throw new Error(`Express asset build did not produce ${expressBinary}`);
	}
	const isolatedPublicDirectory = path.dirname(isolatedPublicAsset);
	const hiddenPublicDirectory = `${isolatedPublicDirectory}.source-hidden`;
	const buildAssetTmp = path.join(project, "build-asset-tmp");
	mkdirSync(buildAssetTmp, { recursive: true });
	const expressBuiltRun = (() => {
		renameSync(isolatedPublicDirectory, hiddenPublicDirectory);
		try {
			return spawnSync(expressBinary, [], {
				cwd: project,
				env: { ...isolatedEnv, TMPDIR: buildAssetTmp },
				encoding: "utf-8",
				timeout: 30_000,
			});
		} finally {
			renameSync(hiddenPublicDirectory, isolatedPublicDirectory);
		}
	})();
	if (
		expressBuiltRun.status !== 0 ||
		!expressBuiltRun.stdout.includes("EXPRESS_ASSETS_SMOKE static payload")
	) {
		throw new Error(
			`built Express asset application failed without its source assets:\n${expressBuiltRun.stdout}\n${expressBuiltRun.stderr}`,
		);
	}
	console.log("ok   build embedded the Express public tree in a standalone application");

	const expressTestOutput = invoke(
		["test", expressTestPath, "--config", expressConfigPath],
		testOnlyEnv,
	);
	if (
		!expressTestOutput.includes("assets-app.test.mjs") ||
		!expressTestOutput.includes("2 passed, 0 failed")
	) {
		throw new Error(
			`Express asset tests did not run inside the product test command:\n${expressTestOutput}`,
		);
	}
	console.log("ok   test exercised Express HTTP behavior with project Mal assets");

	writeFileSync(
		path.join(project, "minimal-runner.test.ts"),
		`import { expect, test } from "maligator:test";

test("runs one assertion", () => {
	expect(1 + 1).toBe(2);
});
`,
	);
	const minimalTest = invokeCaptured(["test", "minimal-runner.test.ts"], testOnlyEnv);
	if (
		minimalTest.signal !== null ||
		minimalTest.status !== 0 ||
		!minimalTest.stdout.includes("minimal-runner.test.ts") ||
		!minimalTest.stdout.includes("1 passed, 0 failed")
	) {
		throw new Error(
			`minimal explicit test did not complete normally: status=${minimalTest.status} signal=${minimalTest.signal}\n${minimalTest.stdout}\n${minimalTest.stderr}`,
		);
	}
	console.log("ok   test runner executes and reports a minimal explicit test");

	writeFileSync(path.join(project, "package.json"), `{"type":"module"}\n`);
	const esmTest = invokeCaptured(["test", "minimal-runner.test.ts"], testOnlyEnv);
	if (
		esmTest.signal !== null ||
		esmTest.status !== 0 ||
		!esmTest.stdout.includes("minimal-runner.test.ts") ||
		!esmTest.stdout.includes("1 passed, 0 failed")
	) {
		throw new Error(
			`standalone ESM test did not complete normally: status=${esmTest.status} signal=${esmTest.signal}\n${esmTest.stdout}\n${esmTest.stderr}`,
		);
	}
	console.log("ok   test runner executes a minimal test in a standalone ESM package");

	writeFileSync(
		path.join(project, "example.test.ts"),
		`import { beforeEach, expect, test } from "maligator:test";
import { basename, join } from "node:path";
import { createServer } from "node:http";

let value: string;
beforeEach(() => {
\tvalue = join("one", "two", "answer.ts");
});
test("interprets async tests with host dependencies", async () => {
\tawait expect(Promise.resolve(basename(value))).resolves.toBe("answer.ts");
\texpect(typeof Headers).toBe("function");
\texpect(new Headers({ "x-test": "yes" }).get("x-test")).toBe("yes");
\tconst server = createServer((_request, response) => {
\t\tresponse.setHeader("content-type", "application/json");
\t\tresponse.end(JSON.stringify({ answer: 42 }));
\t});
\tawait new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
\tconst address = server.address();
\tconst response = await fetch("http://127.0.0.1:" + address.port + "/answer");
\texpect(response.status).toBe(200);
\texpect(response.headers.get("content-type")).toBe("application/json");
\tawait expect(response.json()).resolves.toMatchObject({ answer: 42 });
\tawait new Promise((resolve) => server.close(resolve));
});
`,
	);
	const coldTestOutput = invoke(["test", "example.test.ts"], testOnlyEnv);
	if (
		!coldTestOutput.includes("1 passed, 0 failed") ||
		!coldTestOutput.includes("cache miss")
	) {
		throw new Error(`cold interpreted test run was not successful:\n${coldTestOutput}`);
	}
	const warmTestOutput = invoke(
		[
			"test",
			"example.test.ts",
			"--run",
			"interprets async",
			"--shuffle",
			"18492",
			"--repeat",
			"2",
		],
		testOnlyEnv,
	);
	if (
		!warmTestOutput.includes("Shuffle seed: 18492") ||
		!warmTestOutput.includes("2 passed, 0 failed") ||
		!warmTestOutput.includes("cache hit")
	) {
		throw new Error(`warm interpreted test run did not reuse wire:\n${warmTestOutput}`);
	}
	console.log(
		"ok   test interpreted TypeScript and node:path without an available native compiler",
	);

	const callableCommonjs = path.join(project, "node_modules", "callable-commonjs");
	mkdirSync(callableCommonjs, { recursive: true });
	writeFileSync(path.join(callableCommonjs, "package.json"), `{"main":"index.cjs"}\n`);
	writeFileSync(
		path.join(callableCommonjs, "index.cjs"),
		`module.exports = function callableCommonjs() { return 42; };\n`,
	);
	writeFileSync(
		path.join(project, "commonjs-default.test.ts"),
		`import callableCommonjs from "callable-commonjs";
import { expect, test } from "maligator:test";

test("CommonJS default exports remain callable", () => {
	expect(typeof callableCommonjs).toBe("function");
	expect(callableCommonjs()).toBe(42);
});
`,
	);
	const commonjsDefaultOutput = invoke(["test", "commonjs-default.test.ts"], testOnlyEnv);
	if (!commonjsDefaultOutput.includes("1 passed, 0 failed")) {
		throw new Error(`CommonJS default import test failed:\n${commonjsDefaultOutput}`);
	}
	console.log("ok   test preserved callable CommonJS default exports");

	writeFileSync(
		path.join(project, "namespace.test.ts"),
		`import { expect, test } from "maligator:test";
import * as path from "node:path";
test("preserves namespace import semantics through fallback", () => {
\texpect(path.basename("/one/two.ts")).toBe("two.ts");
});
`,
	);
	const namespaceOutput = invoke(["test", "namespace.test.ts"], testOnlyEnv);
	if (!namespaceOutput.includes("1 passed, 0 failed")) {
		throw new Error(`namespace-import whole-image fallback failed:\n${namespaceOutput}`);
	}

	writeFileSync(
		path.join(project, "syntax.test.ts"),
		`import { test } from "maligator:test";\ntest("broken", () => {\n`,
	);
	const syntaxOutput = invokeFailure(["test", "syntax.test.ts"], testOnlyEnv);
	if (!syntaxOutput.includes("SyntaxError")) {
		throw new Error(`syntax failures were not categorized:\n${syntaxOutput}`);
	}

	writeFileSync(
		path.join(project, "module-load.test.ts"),
		`import { test } from "maligator:test";
throw new Error("module load sentinel");
test("unreachable", () => {});
`,
	);
	const moduleLoadOutput = invokeFailure(["test", "module-load.test.ts"], testOnlyEnv);
	if (
		!moduleLoadOutput.includes("ModuleLoadError") ||
		!moduleLoadOutput.includes("module load sentinel")
	) {
		throw new Error(`module-load failures were not categorized:\n${moduleLoadOutput}`);
	}
	const containedModuleLoadOutput = invokeFailure(
		["test", "example.test.ts", "module-load.test.ts"],
		testOnlyEnv,
	);
	if (
		!containedModuleLoadOutput.includes("1 passed, 1 failed") ||
		!containedModuleLoadOutput.includes("example.test.ts")
	) {
		throw new Error(
			`an image module-load failure did not preserve healthy entries:\n${containedModuleLoadOutput}`,
		);
	}

	for (const [file, value] of [
		["hook-a.test.ts", "a"],
		["hook-b.test.ts", "b"],
	] as const) {
		writeFileSync(
			path.join(project, file),
			`import { beforeEach, expect, test } from "maligator:test";
beforeEach(() => {
\tglobalThis.__testImageHookOwner = ${JSON.stringify(value)};
});
test("keeps root hooks inside the file", () => {
\texpect(globalThis.__testImageHookOwner).toBe(${JSON.stringify(value)});
});
`,
		);
	}
	const hookBoundaryOutput = invoke(
		["test", "hook-a.test.ts", "hook-b.test.ts"],
		testOnlyEnv,
	);
	if (!hookBoundaryOutput.includes("2 passed, 0 failed")) {
		throw new Error(`test-image hooks crossed file boundaries:\n${hookBoundaryOutput}`);
	}

	writeFileSync(
		path.join(project, "assertion.test.ts"),
		`import { expect, test } from "maligator:test";
test("reports source positions", () => {
\tconst received = { status: 200 };
\texpect(received).toEqual({ status: 400 });
});
`,
	);
	const assertionOutput = invokeFailure(["test", "assertion.test.ts"], testOnlyEnv);
	if (
		!assertionOutput.includes("AssertionError") ||
		!assertionOutput.includes("assertion.test.ts:4")
	) {
		throw new Error(`assertion failures lost source diagnostics:\n${assertionOutput}`);
	}
	console.log(
		"ok   test isolated file hooks and categorized contained module/assertion failures",
	);
} finally {
	if (createdConfig) rmSync(configPath, { force: true });
}
progress.complete();
