// Native `process` global acceptance fixture (node surface). Built + run by
// tests/native/node-process.test.ts on the host entry, which invokes it with a
// controlled OS argv / environment and asserts the machine-readable lines below.
//
// It prints, in order: the forwarded argv, a few env probes (direct read, key
// enumeration, spread), and the working directory — then a `RESULT p/t` line for
// the structural self-checks. When NODE_PROCESS_EXIT is set it finally calls
// process.exit(<that number>) so the runner can assert the exit status.
//
// `process` is a free global here (no node:process import), resolved through the
// global object property installed under the node surface.

import importedProcess, {
	emitWarning as importedEmitWarning,
	env as importedEnv,
	hrtime as importedHrtime,
} from "node:process";
import { pathToFileURL } from "node:url";
import requiredProcesses from "./node-process-require.cjs";

const MARKER = "NODE_PROCESS_MARKER";
const UNDEF = "__undef__";

function show(value: unknown): string {
	return value === undefined ? UNDEF : String(value);
}

// --- argv forwarding ---
const argv = process.argv;
console.log("ARGV_LEN " + argv.length);
for (let i = 0; i < argv.length; i++) {
	console.log("ARGV " + i + " " + argv[i]);
}

// --- env: read / enumerate / spread ---
const env = process.env;
const keys = Object.keys(env);
console.log("ENV_READ " + show(env[MARKER]));
console.log("ENV_KEYS_LEN " + keys.length);
console.log("ENV_HAS_MARKER " + (keys.indexOf(MARKER) >= 0));
const spread = { ...env };
console.log("ENV_SPREAD_READ " + show(spread[MARKER]));
console.log("ENV_SPREAD_KEYS_LEN " + Object.keys(spread).length);

// --- cwd ---
console.log("CWD " + process.cwd());

// --- structural self-checks (RESULT line) ---
const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

check("process is object", typeof process === "object" && process !== null);
check("import.meta has stable identity", import.meta === import.meta);
check(
	"import.meta exposes Node path metadata",
	import.meta.filename.endsWith("/tests/local/node-process.mts") &&
		import.meta.dirname.endsWith("/tests/local") &&
		import.meta.url === pathToFileURL(import.meta.filename).href &&
		import.meta.main,
);
check("process has global identity", globalThis.process === process);
check("global aliases globalThis", global === globalThis);
check("node:process default has global identity", importedProcess === process);
check("node:process named env has global identity", importedEnv === process.env);
check(
	"node:process named emitWarning has method identity",
	importedEmitWarning === process.emitWarning,
);
check("node:process named hrtime has method identity", importedHrtime === process.hrtime);
const highResolution = process.hrtime();
check(
	"hrtime returns seconds and nanoseconds",
	Array.isArray(highResolution) &&
		highResolution.length === 2 &&
		highResolution[0] >= 0 &&
		highResolution[1] >= 0 &&
		highResolution[1] < 1_000_000_000,
);
check("hrtime.bigint returns nanoseconds", typeof process.hrtime.bigint() === "bigint");
const tickOrder = ["sync"];
process.nextTick((value) => tickOrder.push(value), "tick");
await Promise.resolve();
check("nextTick queues a callback with arguments", tickOrder.join(",") === "sync,tick");
check(
	"bare and canonical CommonJS process have global identity",
	requiredProcesses.bare === process && requiredProcesses.canonical === process,
);
check("argv is array", Array.isArray(process.argv));
check("argv has argv0 + source entry", process.argv.length >= 2);
check(
	"argv[1] is the source entry",
	process.argv[1].endsWith("/tests/local/node-process.mts"),
);
check(
	"argv0 is a non-empty string",
	typeof process.argv[0] === "string" && process.argv[0].length > 0,
);
check("env is object", typeof process.env === "object" && process.env !== null);
check(
	"env values are strings",
	typeof env[MARKER] === "string" || env[MARKER] === undefined,
);
check("spread preserves keys", Object.keys(spread).length === keys.length);
check("cwd is a function", typeof process.cwd === "function");
check(
	"cwd returns a non-empty string",
	typeof process.cwd() === "string" && process.cwd().length > 0,
);
check("exit is a function", typeof process.exit === "function");
check("kill is a function", typeof process.kill === "function");
check("pid is positive", typeof process.pid === "number" && process.pid > 0);
check(
	"platform is supported",
	process.platform === "darwin" || process.platform === "linux",
);
check("arch is supported", process.arch === "arm64" || process.arch === "x64");
check("versions exposes a conservative Node compatibility level", process.versions.node === "0.0.0");
check("stdout fd", process.stdout.fd === 1);
check("stderr fd", process.stderr.fd === 2);
check("stdout isTTY", typeof process.stdout.isTTY === "boolean");
check("stderr isTTY", typeof process.stderr.isTTY === "boolean");
check("stdout write", process.stdout.write("") === true);
check("stderr write", process.stderr.write("") === true);
check("emitWarning is a function", typeof process.emitWarning === "function");

if (process.env.NODE_PROCESS_WARN === "1") {
	importedEmitWarning("module-warning");
}

function checkExitRangeError(name: string, code: number): void {
	try {
		process.exit(code);
		check(name, false);
	} catch (error) {
		check(name, error instanceof RangeError);
	}
}

checkExitRangeError("exit rejects fractional status", 1.5);
checkExitRangeError("exit rejects NaN status", NaN);
checkExitRangeError("exit rejects positive infinity status", Infinity);
checkExitRangeError("exit rejects negative infinity status", -Infinity);
checkExitRangeError("exit rejects status above safe-integer range", 9007199254740992);
checkExitRangeError("exit rejects status below safe-integer range", -9007199254740992);
try {
	process.exit("1" as unknown as number);
	check("exit rejects non-number status", false);
} catch (error) {
	check("exit rejects non-number status", error instanceof TypeError);
}
console.log("EXIT_INVALID_CONTINUED true");

const originalProcess = process;
const replacement = { marker: "replacement" } as unknown as typeof process;
process = replacement;
check(
	"process assignment updates the global property",
	process === replacement && globalThis.process === replacement,
);
process = originalProcess;
check("process assignment restores global identity", globalThis.process === process);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}
console.log("RESULT " + passed + "/" + results.length);

// --- exit status (opt-in) ---
const exitRequest = process.env.NODE_PROCESS_EXIT;
if (exitRequest !== undefined) {
	if (exitRequest === "default") {
		process.exit();
	} else if (exitRequest === "undefined") {
		process.exit(undefined);
	} else {
		process.exit(Number(exitRequest));
	}
}
