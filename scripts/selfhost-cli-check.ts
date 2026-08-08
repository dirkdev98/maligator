import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { buildProductCli } from "../src/product-builder.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repositoryRoot, ".cache/mal-build/selfhost-cli-product");
const tools = path.join(root, "tools");
const project = path.join(root, "isolated-project");
const distribution = path.join(root, "distribution");
const noTools = path.join(root, "no-tools");
const configPath = path.join(project, "maligator.build.ts");
const fixture = "entry.mts";
const originalPath = process.env.PATH ?? "";

if (spawnSync(process.execPath, ["--version"]).status !== 0) {
	throw new Error("the Node-hosted bootstrap is unavailable");
}
rmSync(root, { recursive: true, force: true });
mkdirSync(tools, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(distribution, { recursive: true });
mkdirSync(noTools, { recursive: true });

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
});
const distributedCli = path.join(distribution, "maligator");
copyFileSync(cli, distributedCli);
chmodSync(distributedCli, 0o755);
console.log(`ok   compiled self-contained product CLI (${distributedCli})`);

function invoke(args: Array<string>, envOverrides: Record<string, string> = {}): string {
	return execFileSync(distributedCli, args, {
		cwd: project,
		env: { ...isolatedEnv, ...envOverrides },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function invokeFailure(
	args: Array<string>,
	envOverrides: Record<string, string> = {},
): string {
	const result = spawnSync(distributedCli, args, {
		cwd: project,
		env: { ...isolatedEnv, ...envOverrides },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status === 0) {
		throw new Error(`command unexpectedly succeeded: maligator ${args.join(" ")}`);
	}
	return `${result.stdout}\n${result.stderr}`;
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

	const runOutput = invoke(["run", "--", "alpha", "two words", "--flag"]);
	if (!runOutput.includes("selfhost-cli alpha|two words|--flag")) {
		throw new Error(`run did not forward arguments:\n${runOutput}`);
	}
	console.log(
		"ok   target materialized binary assets, executed eval, and forwarded arguments",
	);

	writeFileSync(
		path.join(project, "example.test.ts"),
		`import { beforeEach, expect, test } from "maligator:test";
import { basename, join } from "node:path";

let value: string;
beforeEach(() => {
\tvalue = join("one", "two", "answer.ts");
});
test("interprets async tests with host dependencies", async () => {
\tawait expect(Promise.resolve(basename(value))).resolves.toBe("answer.ts");
});
`,
	);
	const testOnlyEnv = {
		PATH: noTools,
		CC: path.join(noTools, "unavailable-cc"),
		CXX: path.join(noTools, "unavailable-cxx"),
	};
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
