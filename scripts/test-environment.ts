import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import * as path from "node:path";

const ambientRuntimeVariables = new Set([
	"ASAN_OPTIONS",
	"GLIBC_TUNABLES",
	"LSAN_OPTIONS",
	"NODE_OPTIONS",
	"UBSAN_OPTIONS",
]);
const ambientRuntimePrefixes = ["DYLD_", "LD_", "MALLOC_", "Malloc"];

export function cleanTestEnvironment(
	overrides: NodeJS.ProcessEnv = {},
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const environment = Object.fromEntries(
		Object.entries(source).filter(
			([name]) =>
				(!name.startsWith("MAL_") ||
					name === "MAL_BUILD_JOBS" ||
					name === "MAL_SANITIZER_WORKERS") &&
				(!name.startsWith("T262_") ||
					name === "T262_COMPILE_WORKERS" ||
					name === "T262_OBJCACHE") &&
				name !== "WPT_ROOT" &&
				!ambientRuntimeVariables.has(name) &&
				!ambientRuntimePrefixes.some((prefix) => name.startsWith(prefix)),
		),
	);
	return { ...environment, ...overrides };
}

function normalizedTestPath(file: string): string {
	return path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/");
}

/** Whether a Vitest selection can execute a native test that binds loopback. */
export function testSelectionRequiresLoopback(
	arguments_: ReadonlyArray<string>,
	loopbackTests: ReadonlySet<string>,
): boolean {
	if (
		arguments_.includes("--help") ||
		arguments_.includes("-h") ||
		arguments_.includes("list")
	) {
		return false;
	}
	const projects: Array<string> = [];
	for (const [index, argument] of arguments_.entries()) {
		if (argument === "--project" && arguments_[index + 1] !== undefined) {
			projects.push(arguments_[index + 1]!);
		} else if (argument.startsWith("--project=")) {
			projects.push(argument.slice("--project=".length));
		}
	}
	if (projects.length > 0 && !projects.includes("native")) return false;

	const selectedTests = arguments_.filter((argument) =>
		/\.test\.[cm]?[jt]s$/.test(argument),
	);
	if (selectedTests.length === 0) return true;
	return selectedTests.some((file) => loopbackTests.has(normalizedTestPath(file)));
}

/** Fail early with an actionable error when the execution sandbox denies listen(0). */
export function assertLoopbackAvailable(): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPERM" || error.code === "EACCES") {
				reject(
					new Error(
						"loopback listen(0) is blocked by the execution sandbox; rerun the exact test command with loopback/network permission (Codex: elevated sandbox). This is an environment failure, not a Maligator regression.",
					),
				);
				return;
			}
			reject(error);
		});
		server.listen(0, "127.0.0.1", () => {
			server.close((error) => (error === undefined ? resolve() : reject(error)));
		});
	});
}

function sameEnvironment(left: NodeJS.ProcessEnv, right: NodeJS.ProcessEnv): boolean {
	const leftEntries = Object.entries(left).filter((entry) => entry[1] !== undefined);
	const rightEntries = Object.entries(right).filter((entry) => entry[1] !== undefined);
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every(([name, value]) => right[name] === value)
	);
}

export function isCanonicalTestEnvironmentChild(
	marker: string,
	overrides: NodeJS.ProcessEnv = {},
	source: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		source[marker] === "1" &&
		sameEnvironment(source, cleanTestEnvironment({ ...overrides, [marker]: "1" }, source))
	);
}

export function reexecWithCleanTestEnvironment(
	marker: string,
	overrides: NodeJS.ProcessEnv = {},
): void {
	if (isCanonicalTestEnvironmentChild(marker, overrides)) return;
	const entrypoint = process.argv[1];
	if (entrypoint === undefined) throw new Error("unable to resolve runner entrypoint");
	const result = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: cleanTestEnvironment({ ...overrides, [marker]: "1" }),
	});
	if (result.error !== undefined) throw result.error;
	if (result.signal !== null) {
		console.error(`runner terminated by ${result.signal}`);
		process.exit(1);
	}
	process.exit(result.status ?? 1);
}
