import { spawnSync } from "node:child_process";

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
				!name.startsWith("MAL_") &&
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
