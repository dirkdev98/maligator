import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import type { ApplicationResources } from "../src/application-images.ts";
import { maligatorCacheDirectory } from "../src/cache-root.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { buildProductCli } from "../src/product-builder.ts";
import { parseProfileCapture, profileCaptureIdentity } from "../src/profile-artifact.ts";
import type { PreparedProfile, ProfileManifest } from "../src/profile-artifact.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const arguments_ = process.argv.slice(2);
let providedCli: string | undefined;
let supervisorOnly = false;
for (let index = 0; index < arguments_.length; index++) {
	const argument = arguments_[index];
	if (argument === "--cli" && providedCli === undefined) {
		const value = arguments_[++index];
		if (value === undefined || value.startsWith("--"))
			throw new Error("--cli requires a path");
		providedCli = path.resolve(value);
	} else if (argument === "--supervisor-only" && !supervisorOnly) supervisorOnly = true;
	else
		throw new Error(
			"usage: node scripts/selfhost-cli-check.ts [--cli PATH] [--supervisor-only]",
		);
}
if (supervisorOnly && providedCli === undefined)
	throw new Error("--supervisor-only requires --cli");
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
const reports = path.join(repositoryRoot, ".cache", "selfhost-cli", String(process.pid));
const projectNodeModules = path.join(project, "node_modules");
const configPath = path.join(project, "maligator.build.ts");
const developmentConfigPath = path.join(project, "maligator.development.build.ts");
const expressFixturePath = "tests/fixtures/express-5";
const expressConfigPath = `${expressFixturePath}/assets-app.build.mts`;
const expressTestPath = `${expressFixturePath}/assets-app.test.mjs`;
const fixture = "entry.mts";
const originalPath = process.env.PATH ?? "";
const progress = new CommandProgress("selfhost-cli");
progress.start(
	providedCli === undefined
		? "build and exercise the isolated product CLI"
		: "exercise the supplied isolated product CLI",
);

if (spawnSync(process.execPath, ["--version"]).status !== 0) {
	throw new Error("the Node-hosted bootstrap is unavailable");
}
rmSync(root, { recursive: true, force: true });
mkdirSync(tools, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(distribution, { recursive: true });
mkdirSync(noTools, { recursive: true });
mkdirSync(reports, { recursive: true });
console.log(`step acceptance reports ${reports}`);
cpSync(
	path.join(repositoryRoot, expressFixturePath),
	path.join(project, expressFixturePath),
	{ recursive: true },
);
symlinkSync(
	path.join(repositoryRoot, "node_modules"),
	projectNodeModules,
	process.platform === "win32" ? "junction" : "dir",
);

if (!supervisorOnly) {
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

const cli =
	providedCli ??
	buildProductCli({
		repositoryRoot,
		outDir: root,
		onProgress: (message) => console.log(`step ${message}`),
	});
console.log(
	`step selected CLI ${cli} (sha256 ${createHash("sha256").update(readFileSync(cli)).digest("hex")})`,
);
const distributedCli = path.join(distribution, "maligator");
copyFileSync(cli, distributedCli);
chmodSync(distributedCli, 0o755);
console.log(`ok   copied selected product CLI (${distributedCli})`);
writeFileSync(
	path.join(reports, "identity.json"),
	`${JSON.stringify({ sourceCli: cli, sha256: createHash("sha256").update(readFileSync(distributedCli)).digest("hex"), providedCli: providedCli ?? null, supervisorOnly, platform: process.platform, arch: process.arch, node: process.version }, null, 2)}\n`,
);

let invocation = 0;
function invokeCaptured(args: Array<string>, envOverrides: Record<string, string> = {}) {
	const result = spawnSync(distributedCli, args, {
		cwd: project,
		env: { ...isolatedEnv, ...envOverrides },
		encoding: "utf-8",
		timeout: supervisorOnly ? 30_000 : 180_000,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "pipe"],
	});
	writeFileSync(
		path.join(reports, `command-${++invocation}.json`),
		`${JSON.stringify({ args, cli, pid: result.pid, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2)}\n`,
	);
	if (result.error)
		throw new Error(
			`maligator ${args.join(" ")} failed: ${result.error.message}\n${result.stdout}\n${result.stderr}`,
			{ cause: result.error },
		);
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

function checkApplicationPids(
	output: string,
	supervisorPid: number | undefined,
	sameProcess: boolean,
	marker: string,
): void {
	const pids = output
		.split("\n")
		.filter((line) => line.startsWith(`${marker} `))
		.map((line) => Number(line.slice(marker.length + 1)));
	if (
		supervisorPid === undefined ||
		pids.length === 0 ||
		pids.some(
			(pid) =>
				!Number.isSafeInteger(pid) || pid <= 0 || (pid === supervisorPid) !== sameProcess,
		)
	)
		throw new Error(
			`application did not use the expected ${sameProcess ? "supervisor" : "separate"} process: supervisor=${supervisorPid}, application=${JSON.stringify(pids)}\n${output}`,
		);
}

function checkProfile(directory: string, command: "run" | "test"): void {
	const metadata = JSON.parse(
		readFileSync(path.join(directory, "metadata.json"), "utf-8"),
	) as PreparedProfile;
	const manifest = JSON.parse(
		readFileSync(path.join(directory, "manifest.json"), "utf-8"),
	) as ProfileManifest;
	const payload = readFileSync(path.join(directory, "capture.bin"));
	const capture = parseProfileCapture(payload);
	const identity = profileCaptureIdentity(metadata);
	if (
		capture.schema < 4 ||
		capture.captureIdentity !== identity ||
		metadata.captureIdentity !== identity ||
		manifest.captureIdentity !== identity ||
		manifest.buildId !== metadata.buildId ||
		manifest.command !== command ||
		manifest.status !== "complete" ||
		!manifest.workloadSucceeded ||
		manifest.payloadDigest !== createHash("sha256").update(payload).digest("hex")
	)
		throw new Error(`profile ${command} did not publish a valid completed capture`);
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

async function waitForWatchRevision(read: () => string, revision: number): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 30_000) {
		const port = [...read().matchAll(/WATCH_HTTP_PORT (\d+)/g)].at(-1)?.[1];
		if (port !== undefined) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}`, {
					signal: AbortSignal.timeout(250),
				});
				if (response.ok && (await response.text()) === String(revision)) return;
			} catch {
				await new Promise((resolve) => {
					setTimeout(resolve, 25);
				});
				continue;
			}
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	throw new Error(`watcher did not serve revision ${revision}:\n${read()}`);
}

function stopDevelopmentChild(
	child: ChildProcess,
	read: () => string,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve(child.exitCode);
			return;
		}
		const kill = (signal: NodeJS.Signals) => {
			if (process.platform !== "win32" && child.pid !== undefined) {
				try {
					process.kill(-child.pid, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH")
						reject(error instanceof Error ? error : new Error(String(error)));
				}
			} else child.kill(signal);
		};
		const force = setTimeout(() => {
			kill("SIGKILL");
		}, 1500);
		const timeout = setTimeout(() => {
			reject(new Error(`development child did not stop after SIGKILL:\n${read()}`));
		}, 5000);
		child.once("exit", (code) => {
			clearTimeout(force);
			clearTimeout(timeout);
			resolve(code);
		});
		kill("SIGTERM");
	});
}

async function checkPersistentTestWatch(
	failedOnly = false,
	isolated = false,
	cancelInFlight = false,
): Promise<void> {
	const watchTestDirectory = path.join(
		project,
		cancelInFlight ? "watch-tests-cancel" : "watch-tests",
	);
	const marker = path.join(project, "watch-failure-seen");
	rmSync(marker, { force: true });
	const waiting: Array<{ end(body: string): void }> = [];
	const barrier = isolated
		? createServer((_request, response) => {
				waiting.push(response);
				if (waiting.length === 2) {
					for (const current of waiting.splice(0)) current.end("paired");
				}
			})
		: undefined;
	if (barrier !== undefined)
		await new Promise<void>((resolve) => {
			barrier.listen(0, "127.0.0.1", resolve);
		});
	const address = barrier?.address();
	const barrierOrigin =
		address !== null && typeof address === "object"
			? `http://127.0.0.1:${address?.port}`
			: undefined;
	mkdirSync(watchTestDirectory, { recursive: true });
	const watchTestLeaf = path.join(watchTestDirectory, "revision.mts");
	const watchTestState = path.join(watchTestDirectory, "state.mts");
	const watchTestFirst = path.join(watchTestDirectory, "first.test.mts");
	const watchTestSecond = path.join(watchTestDirectory, "second.test.mts");
	writeFileSync(watchTestLeaf, "export const revision = 0;\n");
	writeFileSync(watchTestState, "export const loaded = [];\n");
	if (cancelInFlight)
		writeFileSync(
			path.join(watchTestDirectory, "bulk.mts"),
			`export const bulk = [${Array.from({ length: 2000 }, (_, index) => `() => ${index}`).join(",")}];\n`,
		);
	for (const [file, label] of [
		[watchTestFirst, "first"],
		[watchTestSecond, "second"],
	]) {
		writeFileSync(
			file!,
			`import { expect, test } from "maligator:test";
import { execution } from "maligator:process";
${failedOnly ? 'import { existsSync, writeFileSync } from "node:fs";' : ""}
import { loaded } from "./state.mts";
import { revision } from "./revision.mts";
${cancelInFlight ? 'import { bulk } from "./bulk.mts";' : ""}
loaded.push("${label}");
let calls = 0;
test("watch ${label}", async () => {
	calls++;
	expect(calls <= 2).toBe(true);
	${cancelInFlight ? "expect(bulk[0]()).toBe(0);" : ""}
	expect(loaded.slice().sort().join("|")).toBe(${JSON.stringify(isolated ? label : "first|second")});
	expect(execution.options.repeat).toBe(2);
	expect(execution.options.shuffleSeed).toBe(1337);
	expect(execution.options.timeoutMs).toBe(1234);
	expect(execution.options.nameFilter).toBe("watch");
	expect(execution.options.bail).toBe(false);
	${isolated ? `expect(await (await fetch(${JSON.stringify(barrierOrigin)})).text()).toBe("paired");` : ""}
	console.log("WATCH_TEST_REVISION " + revision + " CALL " + calls + " FILE ${label}");
	${failedOnly && label === "second" ? `const seen = existsSync(${JSON.stringify(marker)}); writeFileSync(${JSON.stringify(marker)}, "seen"); expect(seen).toBe(true);` : ""}
});
`,
		);
	}
	const testWatcher = spawn(
		distributedCli,
		[
			"test",
			watchTestFirst,
			watchTestSecond,
			"--watch",
			"--status",
			"--run",
			"watch",
			...(failedOnly ? ["--watch-failed"] : []),
			...(isolated
				? ["--isolate", "--concurrency", "2", "--compile-concurrency", "2"]
				: []),
			"--shuffle",
			"1337",
			"--repeat",
			"2",
			"--timeout",
			"1234",
			"--config",
			developmentConfigPath,
		],
		{
			cwd: project,
			env: { ...isolatedEnv, ...testOnlyEnv },
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let testWatchOutput = "";
	let testWatchStatusOutput = "";
	let phaseLines = "";
	let phaseObservationError: Error | undefined;
	let phaseCancellationSent = false;
	const firstAcceptedGeneration = cancelInFlight ? 2 : 1;
	testWatcher.stdout.setEncoding("utf-8");
	testWatcher.stderr.setEncoding("utf-8");
	testWatcher.stdout.on("data", (chunk: string) => {
		testWatchOutput += chunk;
	});
	testWatcher.stderr.on("data", (chunk: string) => {
		testWatchOutput += chunk;
		testWatchStatusOutput += chunk;
		if (cancelInFlight && !phaseCancellationSent) {
			phaseLines += chunk;
			const lines = phaseLines.split("\n");
			phaseLines = lines.pop()!;
			for (const line of lines) {
				if (!line.startsWith("Test session ")) continue;
				let snapshot: {
					runningGeneration?: number;
					events: Array<{ compilation?: { label: string; state: string } }>;
				};
				try {
					snapshot = JSON.parse(line.slice("Test session ".length)) as typeof snapshot;
				} catch (error) {
					phaseObservationError =
						error instanceof Error ? error : new Error(String(error));
					testWatcher.kill("SIGTERM");
					break;
				}
				const phase = snapshot.events.at(-1)?.compilation;
				if (
					snapshot.runningGeneration === 1 &&
					phase?.label === "Prepare test application" &&
					phase.state === "started"
				) {
					phaseCancellationSent = true;
					testWatcher.kill("SIGHUP");
					break;
				}
			}
		}
	});
	let testWatchExit: number | null = null;
	try {
		await waitForOutput(
			() => {
				if (phaseObservationError !== undefined) throw phaseObservationError;
				return testWatchOutput;
			},
			`Test watch generation ${firstAcceptedGeneration}: ${failedOnly ? 1 : 0} failed; seed 1337`,
			30_000,
		);
		if (
			cancelInFlight &&
			(!phaseCancellationSent ||
				!testWatchOutput.includes("Test watch generation 1: superseded") ||
				testWatchOutput.includes("Test watch generation 1: 0 failed;"))
		)
			throw new Error(
				`in-flight compilation cancellation published a stale generation:\n${testWatchOutput}`,
			);
		const firstResources = latestTestWatchResources(testWatchStatusOutput);
		if (
			firstResources.loadedImages !== (isolated ? 2 : 1) ||
			firstResources.runningApplications !== 0
		)
			throw new Error(
				`completed watch retained unexpected resources: ${JSON.stringify(firstResources)}`,
			);
		const firstRunEnd = testWatchOutput.length;
		testWatcher.kill("SIGHUP");
		await waitForOutput(
			() => testWatchOutput.slice(firstRunEnd),
			`Test watch generation ${firstAcceptedGeneration + 1}: 0 failed; seed 1337`,
			30_000,
		);
		if (!testWatchOutput.slice(firstRunEnd).includes("WATCH_TEST_REVISION 0 CALL 1")) {
			throw new Error(
				`unchanged test watch rerun did not start fresh module state:\n${testWatchOutput}`,
			);
		}
		const rerunOutput = testWatchOutput.slice(firstRunEnd);
		if (
			failedOnly &&
			(rerunOutput.includes("FILE first") || !rerunOutput.includes("FILE second"))
		)
			throw new Error(
				`failed-only rerun did not select only the failed file:\n${rerunOutput}`,
			);
		if (
			isolated &&
			!rerunOutput.includes(
				"Scheduling: 2 compiler jobs, 2 application isolates; file isolation",
			)
		)
			throw new Error(
				`isolated watch did not retain its configured scheduling limits:\n${rerunOutput}`,
			);
		const secondResources = latestTestWatchResources(testWatchStatusOutput);
		if (JSON.stringify(firstResources) !== JSON.stringify(secondResources))
			throw new Error(
				`unchanged watch rerun grew retained resources: ${JSON.stringify({ firstResources, secondResources })}`,
			);
		const secondRunEnd = testWatchOutput.length;
		writeFileSync(watchTestLeaf, "export const revision = 1;\n");
		await waitForOutput(
			() => testWatchOutput.slice(secondRunEnd),
			"WATCH_TEST_REVISION 1 CALL 1",
			30_000,
		);
		await waitForOutput(
			() => testWatchOutput.slice(secondRunEnd),
			"0 failed; seed 1337",
			30_000,
		);
	} finally {
		try {
			testWatchExit = await stopDevelopmentChild(testWatcher, () => testWatchOutput);
		} finally {
			writeFileSync(
				path.join(
					reports,
					`test-watch-${cancelInFlight ? "cancellation" : isolated ? "file-isolated" : failedOnly ? "failed-only" : "shared"}.log`,
				),
				testWatchOutput,
			);
			rmSync(watchTestDirectory, { recursive: true, force: true });
			rmSync(marker, { force: true });
			if (barrier !== undefined) {
				barrier.closeAllConnections();
				await new Promise<void>((resolve, reject) => {
					barrier.close((error) => {
						if (error) reject(error);
						else resolve();
					});
				});
			}
		}
	}
	if (testWatchExit !== 0)
		throw new Error(`test watch exited with ${testWatchExit}:\n${testWatchOutput}`);
	const stoppedResources = latestTestWatchResources(testWatchStatusOutput);
	if (stoppedResources.loadedImages !== 0 || stoppedResources.runningApplications !== 0)
		throw new Error(
			`stopped watch retained application resources: ${JSON.stringify(stoppedResources)}`,
		);
	console.log(
		`ok   ${cancelInFlight ? "phase-canceled" : isolated ? "file-isolated" : failedOnly ? "failed-file" : "shared-suite"} test watch reused immutable images, joined fresh applications, preserved static options, served the changed test revision, and released application resources`,
	);
}

function latestTestWatchResources(output: string) {
	const line = output
		.split("\n")
		.filter((current) => current.startsWith("Test session "))
		.at(-1);
	if (line === undefined)
		throw new Error(`test watch did not expose a resource snapshot:\n${output}`);
	const snapshot = JSON.parse(line.slice("Test session ".length)) as {
		resources?: ApplicationResources;
	};
	if (snapshot.resources === undefined)
		throw new Error("native application resource inspection is unavailable");
	return snapshot.resources;
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
		path.join(project, "helper.mts"),
		`export interface HelperValue { readonly label: string }\nconst helperDefault: HelperValue = { label: "compact" };\nexport default helperDefault;\nexport const ok = <const ValueType>(value: ValueType) => ({ value });\n`,
	);
	writeFileSync(
		path.join(project, fixture),
		`import { readFileSync } from "node:fs";\nimport helperDefault, { ok, type HelperValue } from "./helper.mts";\n\nconst expected = [0, 255, 195, 40, 65];\nconst payload = readFileSync(globalThis.mal.assets.materialize("payload"));\nif (payload.length !== expected.length || payload.some((value, index) => value !== expected[index])) process.exit(18);\nif (eval("20 + 22") !== 42) process.exit(19);\nconst genericResult: { value: HelperValue } = ok(helperDefault);\nif (genericResult.value.label !== "compact") process.exit(20);\nconst actual = process.argv.slice(2);\nconsole.log(\`selfhost-cli \${actual.join("|")}\`);\n`,
	);
	writeFileSync(
		developmentConfigPath,
		`export default {
	entry: "development.mts",
	surface: { webPlatform: true, node: true },
};
`,
	);
	const mutableDevelopmentConfigPath = path.join(
		project,
		"mutable.development.build.mts",
	);
	writeFileSync(
		mutableDevelopmentConfigPath,
		`export default {
	entry: "development.mts",
	engine: { primordials: "mutable" },
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
	console.log("APPLICATION_PID " + process.pid);
}, 0);
`,
	);
	const developmentRun = invokeCaptured(
		["run", "--config", developmentConfigPath, "--", "alpha", "two words"],
		testOnlyEnv,
	);
	if (
		developmentRun.status !== 0 ||
		developmentRun.signal !== null ||
		!developmentRun.stdout.includes("toolchain-free two.ts example.test alpha|two words")
	) {
		throw new Error(
			`toolchain-free development run failed:\n${developmentRun.stdout}\n${developmentRun.stderr}`,
		);
	}
	checkApplicationPids(
		developmentRun.stdout,
		developmentRun.pid,
		true,
		"APPLICATION_PID",
	);
	console.log("ok   packaged CLI ran Node and Web development code without a toolchain");
	const mutableRun = invokeCaptured(
		["run", "--config", mutableDevelopmentConfigPath, "--", "alpha", "two words"],
		testOnlyEnv,
	);
	if (
		mutableRun.status !== 0 ||
		mutableRun.signal !== null ||
		!mutableRun.stdout.includes("toolchain-free two.ts example.test alpha|two words")
	)
		throw new Error(
			`mutable process fallback failed:\n${mutableRun.stdout}\n${mutableRun.stderr}`,
		);
	checkApplicationPids(mutableRun.stdout, mutableRun.pid, false, "APPLICATION_PID");
	console.log(
		"ok   mutable primordial run used a separate embedded process without a toolchain",
	);

	const workerConfig = "workers.build.mts";
	const workerEntry = path.join(project, "workers.mts");
	const workerJobs = path.join(project, "worker-jobs.mts");
	writeFileSync(
		path.join(project, workerConfig),
		`export default {
	entry: "workers.mts",
	outputName: "selfhost-workers",
	engine: { eval: false, regexp: false, intl: { enabled: false } },
	surface: { webPlatform: false, node: true, maligator: true },
};
`,
	);
	writeFileSync(
		workerJobs,
		`import { transfer, type TaskContext } from "maligator:workers";
export function change(context: TaskContext, buffer: ArrayBuffer, shared: SharedArrayBuffer) {
	context.throwIfCancelled();
	new Uint8Array(buffer)[0] = 42;
	Atomics.add(new Int32Array(shared), 0, 1);
	return transfer(buffer, [buffer]);
}
`,
	);
	writeFileSync(
		workerEntry,
		`import { createWorkerUrl, createPool } from "maligator:workers";
const pool = createPool<typeof import("./worker-jobs.mts")>(createWorkerUrl("./worker-jobs.mts", import.meta.url), { size: 2 });
try {
	await pool.ready;
	const buffer = new ArrayBuffer(8);
	const shared = new SharedArrayBuffer(4);
	const pending = pool.run("change", [buffer, shared], { transfer: [buffer] });
	if (buffer.byteLength !== 0) throw new Error("worker transfer did not detach");
	const result = await pending;
	if (new Uint8Array(result)[0] !== 42 || Atomics.load(new Int32Array(shared), 0) !== 1) throw new Error("worker result mismatch");
	console.log("selfhost-workers PASS");
} finally {
	await pool.close();
}
`,
	);
	const workerDevelopment = invoke(["run", "--config", workerConfig], testOnlyEnv);
	if (workerDevelopment !== "selfhost-workers PASS\n") {
		throw new Error(`packaged worker development failed:\n${workerDevelopment}`);
	}
	if (!supervisorOnly) {
		const workerBuild = invoke(["build", "--config", workerConfig]);
		const workerBinary = path.resolve(project, workerBuild.trim());
		const workerHidden = `${workerEntry}.source-hidden`;
		const jobsHidden = `${workerJobs}.source-hidden`;
		renameSync(workerEntry, workerHidden);
		try {
			renameSync(workerJobs, jobsHidden);
			try {
				const workerRun = spawnSync(workerBinary, [], {
					cwd: project,
					env: testOnlyEnv,
					encoding: "utf8",
					timeout: 30_000,
					killSignal: "SIGKILL",
				});
				if (workerRun.error !== undefined) throw workerRun.error;
				if (
					workerRun.status !== 0 ||
					workerRun.stderr !== "" ||
					workerRun.stdout !== "selfhost-workers PASS\n"
				) {
					throw new Error(
						`packaged worker build failed:\n${workerRun.stdout}\n${workerRun.stderr}`,
					);
				}
			} finally {
				renameSync(jobsHidden, workerJobs);
			}
		} finally {
			renameSync(workerHidden, workerEntry);
		}
		console.log(
			"ok   packaged CLI ran worker pools without a toolchain and embedded worker sources",
		);
	}

	const watchEntry = path.join(project, "watch.mts");
	const watchSource = (revision: number) =>
		`import { createServer } from "node:http";
import { ready } from "maligator:application";
const server = createServer((_request, response) => { response.end("${revision}"); });
server.listen(0, "127.0.0.1", () => {
	console.log("WATCH_APPLICATION_PID " + process.pid);
	console.log("WATCH_HTTP_PORT " + server.address().port);
	ready();
});
`;
	for (const mode of [
		{
			sameProcess: true,
			configPath: developmentConfigPath,
			logName: "development-watch",
		},
		{
			sameProcess: false,
			configPath: mutableDevelopmentConfigPath,
			logName: "development-watch-process-fallback",
		},
	]) {
		writeFileSync(watchEntry, watchSource(0));
		const watcher = spawn(
			distributedCli,
			["dev", watchEntry, "--status", "--config", mode.configPath],
			{
				cwd: project,
				detached: process.platform !== "win32",
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
		let watchExit: number | null = null;
		try {
			await waitForWatchRevision(() => watchOutput, 0);
			if (mode.sameProcess) await waitForOutput(() => watchOutput, '"state":"ready"');
			checkApplicationPids(
				watchOutput,
				watcher.pid,
				mode.sameProcess,
				"WATCH_APPLICATION_PID",
			);
			writeFileSync(watchEntry, "export const =;\n");
			await waitForOutput(() => watchOutput, "Rebuild failed:");
			await waitForWatchRevision(() => watchOutput, 0);
			writeFileSync(watchEntry, watchSource(1));
			await waitForWatchRevision(() => watchOutput, 1);
			checkApplicationPids(
				watchOutput,
				watcher.pid,
				mode.sameProcess,
				"WATCH_APPLICATION_PID",
			);
		} finally {
			watchExit = await stopDevelopmentChild(watcher, () => watchOutput);
			writeFileSync(path.join(reports, `${mode.logName}.log`), watchOutput);
			writeFileSync(
				path.join(reports, `${mode.logName}-identity.json`),
				`${JSON.stringify({ pid: watcher.pid, configPath: mode.configPath, expectedBackend: mode.sameProcess ? "thread" : "process", status: watchExit }, null, 2)}\n`,
			);
		}
		if (watchExit !== 0) {
			throw new Error(`watcher exited with ${watchExit}:\n${watchOutput}`);
		}
		const developmentStatus = watchOutput
			.split("\n")
			.filter((line) => line.startsWith("Session "))
			.at(-1);
		if (developmentStatus === undefined)
			throw new Error(`dev did not publish its stopped status:\n${watchOutput}`);
		const developmentSnapshot = JSON.parse(
			developmentStatus.slice("Session ".length),
		) as {
			resources?: ApplicationResources;
			application?: { backend: string };
		};
		const developmentResources = developmentSnapshot.resources;
		if (
			developmentResources === undefined ||
			developmentResources.loadedImages !== 0 ||
			developmentResources.runningApplications !== 0 ||
			developmentSnapshot.application?.backend !==
				(mode.sameProcess ? "thread" : "process")
		)
			throw new Error(
				`dev retained application resources after stop: ${JSON.stringify(developmentResources)}`,
			);
		console.log(
			`ok   ${mode.sameProcess ? "thread" : "mutable process fallback"} development watcher served both revisions without a toolchain`,
		);
	}

	if (!supervisorOnly) {
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
			timeout: 180_000,
			killSignal: "SIGKILL",
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

		const productionConfig = "production.build.mts";
		writeFileSync(
			path.join(project, productionConfig),
			`export default {
	entry: "production-entry.mts",
	outputName: "selfhost-cli-production",
	assets: { payload: { type: "file", path: "payload.bin" } },
	engine: { eval: true, regexp: true, intl: { enabled: false } },
	surface: { webPlatform: false, node: true, maligator: true },
};
`,
		);
		writeFileSync(
			path.join(project, "production-entry.mts"),
			`if (typeof globalThis.RegExp !== "function" || typeof globalThis.Intl !== "undefined") throw new Error("production engine feature mismatch");
console.log("selfhost-production RegExp=function Intl=undefined");
${readFileSync(path.join(project, fixture), "utf-8")}`,
		);
		const productionOutput = invoke([
			"build",
			"--production",
			"--config",
			productionConfig,
		]);
		const productionBinary = path.resolve(project, productionOutput.trim());
		if (!existsSync(productionBinary))
			throw new Error(`production build did not produce ${productionBinary}`);
		const productionRun = spawnSync(
			productionBinary,
			["production", "two words", "--flag"],
			{
				cwd: project,
				env: { ...isolatedEnv, ...testOnlyEnv },
				encoding: "utf-8",
				timeout: 30_000,
				killSignal: "SIGKILL",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		writeFileSync(
			path.join(reports, "production-run.json"),
			`${JSON.stringify({ binary: productionBinary, sha256: createHash("sha256").update(readFileSync(productionBinary)).digest("hex"), pid: productionRun.pid, status: productionRun.status, signal: productionRun.signal, error: productionRun.error?.message, stdout: productionRun.stdout, stderr: productionRun.stderr }, null, 2)}\n`,
		);
		if (
			productionRun.error !== undefined ||
			productionRun.status !== 0 ||
			productionRun.signal !== null ||
			productionRun.stdout !==
				"selfhost-production RegExp=function Intl=undefined\nselfhost-cli production|two words|--flag\n"
		)
			throw new Error(
				`production application failed:\n${productionRun.stdout}\n${productionRun.stderr}`,
				{ cause: productionRun.error },
			);
		console.log(
			"ok   production build executed assets, eval, and forwarded arguments without a toolchain",
		);

		const profileConfig = "profile.build.mts";
		writeFileSync(
			path.join(project, profileConfig),
			`export default {
	entry: "profile-entry.mts",
	engine: { eval: false, regexp: false, intl: { enabled: false } },
	surface: { webPlatform: false, node: true },
};
`,
		);
		writeFileSync(
			path.join(project, "profile-entry.mts"),
			`if (typeof globalThis.RegExp !== "undefined" || typeof globalThis.Intl !== "undefined") throw new Error("profile engine feature mismatch");
console.log("selfhost-profile RegExp=undefined Intl=undefined " + process.argv.slice(2).join("|"));
console.log("PROFILE_APPLICATION_PID " + process.pid);
`,
		);
		const runProfileDirectory = path.join(reports, "profile-run");
		const profiledRun = invokeCaptured(
			["run", "--profile", "--config", profileConfig, "--", "two words"],
			{ MALIGATOR_PROFILE_DIRECTORY: runProfileDirectory },
		);
		if (
			profiledRun.status !== 0 ||
			profiledRun.signal !== null ||
			!profiledRun.stdout.includes(
				"selfhost-profile RegExp=undefined Intl=undefined two words",
			)
		)
			throw new Error(
				`profiled run failed:\n${profiledRun.stdout}\n${profiledRun.stderr}`,
			);
		checkApplicationPids(
			profiledRun.stdout,
			profiledRun.pid,
			false,
			"PROFILE_APPLICATION_PID",
		);
		checkProfile(runProfileDirectory, "run");
		writeFileSync(
			path.join(project, "profile.test.mts"),
			`import { expect, test } from "maligator:test";
test("profile preserves disabled engine features", () => {
	expect(typeof globalThis.RegExp).toBe("undefined");
	expect(typeof globalThis.Intl).toBe("undefined");
	console.log("PROFILE_TEST_PID " + process.pid);
});
`,
		);
		const testProfileDirectory = path.join(reports, "profile-test");
		const profiledTest = invokeCaptured(
			["test", "--profile", "--config", profileConfig, "profile.test.mts"],
			{ MALIGATOR_PROFILE_DIRECTORY: testProfileDirectory },
		);
		if (
			profiledTest.status !== 0 ||
			profiledTest.signal !== null ||
			!profiledTest.stdout.includes("1 passed, 0 failed")
		)
			throw new Error(
				`profiled tests failed:\n${profiledTest.stdout}\n${profiledTest.stderr}`,
			);
		checkApplicationPids(
			profiledTest.stdout,
			profiledTest.pid,
			false,
			"PROFILE_TEST_PID",
		);
		checkProfile(testProfileDirectory, "test");
		console.log(
			"ok   run and test profiles used separate AOT processes, disabled features, and valid captures",
		);

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
				detached: process.platform !== "win32",
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
		const isolatedPublicAsset = path.join(
			project,
			expressFixturePath,
			"public/hello.txt",
		);
		let expressWatchExit: number | null | undefined;
		const expressOrigins = () =>
			[
				...expressWatchOutput.matchAll(
					/EXPRESS_ASSETS_READY (http:\/\/127\.0\.0\.1:\d+)/g,
				),
			].map((match) => match[1]!);
		const expectAsset = async (expected: string) => {
			const origins = expressOrigins();
			const origin = origins.at(-1);
			if (origin === undefined)
				throw new Error(`Express dev server did not publish an origin`);
			const response = await fetch(`${origin}/assets/hello.txt`, {
				signal: AbortSignal.timeout(5000),
			});
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
			expressWatchExit = await stopDevelopmentChild(
				expressWatcher,
				() => expressWatchOutput,
			);
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
					killSignal: "SIGKILL",
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
		console.log(
			"ok   build embedded the Express public tree in a standalone application",
		);

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
	}

	unlinkSync(projectNodeModules);

	writeFileSync(
		path.join(project, "minimal-runner.test.mts"),
		`import { expect, test } from "maligator:test";

test("runs one assertion", () => {
	expect(1 + 1).toBe(2);
});
`,
	);
	const minimalTest = invokeCaptured(["test", "minimal-runner.test.mts"], testOnlyEnv);
	if (
		minimalTest.signal !== null ||
		minimalTest.status !== 0 ||
		!minimalTest.stdout.includes("minimal-runner.test.mts") ||
		!minimalTest.stdout.includes("1 passed, 0 failed")
	) {
		throw new Error(
			`minimal explicit test did not complete normally: status=${minimalTest.status} signal=${minimalTest.signal}\n${minimalTest.stdout}\n${minimalTest.stderr}`,
		);
	}
	console.log("ok   test runner executes and reports a minimal explicit test");

	await checkPersistentTestWatch();
	await checkPersistentTestWatch(true);
	await checkPersistentTestWatch(false, true);
	await checkPersistentTestWatch(false, false, true);

	writeFileSync(path.join(project, "package.json"), `{"type":"module"}\n`);
	renameSync(
		path.join(project, "minimal-runner.test.mts"),
		path.join(project, "minimal-runner.test.ts"),
	);
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
	const repeatedTestArgs = [
		"test",
		"example.test.ts",
		"--run",
		"interprets async",
		"--shuffle",
		"18492",
		"--repeat",
		"2",
	];
	const coldTestOutput = invoke(repeatedTestArgs, testOnlyEnv);
	if (
		!coldTestOutput.includes("Shuffle seed: 18492") ||
		!coldTestOutput.includes("2 passed, 0 failed") ||
		!coldTestOutput.includes("cache miss")
	) {
		throw new Error(`cold interpreted test run was not successful:\n${coldTestOutput}`);
	}
	const warmTestOutput = invoke(repeatedTestArgs, testOnlyEnv);
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
if (providedCli !== undefined) rmSync(root, { recursive: true, force: true });
