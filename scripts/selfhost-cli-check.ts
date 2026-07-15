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

function invoke(args: Array<string>): string {
	return execFileSync(distributedCli, args, {
		cwd: project,
		env: isolatedEnv,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
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
		`import { defineBuild } from "maligator";\n\nconst nodeSurface: boolean = process.env.SELFHOST_CLI_NODE === "1";\nexport default defineBuild({\n\tentry: ${JSON.stringify(fixture)},\n\toutputName: "selfhost-cli-app",\n\tassets: { payload: { type: "file", path: "payload.bin" } },\n\tengine: { eval: true, regexp: false, intl: { enabled: false } },\n\tsurface: { webPlatform: false, node: nodeSurface, maligator: true },\n});\n`,
	);
	writeFileSync(
		path.join(project, "payload.bin"),
		new Uint8Array([0, 0xff, 0xc3, 0x28, 65]),
	);
	writeFileSync(
		path.join(project, fixture),
		`import { readFileSync } from "node:fs";\n\nconst expected = [0, 255, 195, 40, 65];\nconst payload = readFileSync(globalThis.mal.assets.materialize("payload"));\nif (payload.length !== expected.length || payload.some((value, index) => value !== expected[index])) process.exit(18);\nif (eval("20 + 22") !== 42) process.exit(19);\nconst actual = process.argv.slice(2);\nconsole.log(\`selfhost-cli \${actual.join("|")}\`);\n`,
	);

	const doctorOutput = invoke(["doctor", "--verbose"]);
	if (!doctorOutput.includes("Toolchain is ready.")) {
		throw new Error(`doctor did not accept the isolated toolchain:\n${doctorOutput}`);
	}
	console.log("ok   doctor found the isolated native toolchain");

	const buildOutput = invoke(["build"]);
	if (!buildOutput.includes("Binary:") || !buildOutput.includes("selfhost-cli-app")) {
		throw new Error(`build did not report its output:\n${buildOutput}`);
	}
	console.log("ok   distributed compiler built the configured application");

	const runOutput = invoke(["run", "--", "alpha", "two words", "--flag"]);
	if (!runOutput.includes("selfhost-cli alpha|two words|--flag")) {
		throw new Error(`run did not forward arguments:\n${runOutput}`);
	}
	if (!runOutput.includes("Exit: 0")) {
		throw new Error(`run did not report success:\n${runOutput}`);
	}
	console.log(
		"ok   target materialized binary assets, executed eval, and forwarded arguments",
	);
} finally {
	if (createdConfig) rmSync(configPath, { force: true });
}
