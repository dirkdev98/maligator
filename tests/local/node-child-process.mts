import { execFileSync } from "node:child_process";

const results: Array<[string, boolean]> = [];

function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

function errorFrom(fn: () => unknown): {
	code?: string;
	status?: number | null;
	signal?: string | null;
	stdout?: string | null;
	stderr?: string | null;
} {
	try {
		fn();
	} catch (error) {
		return error as {
			code?: string;
			status?: number | null;
			signal?: string | null;
			stdout?: string | null;
			stderr?: string | null;
		};
	}
	return {};
}

function throws(fn: () => unknown): boolean {
	try {
		fn();
	} catch {
		return true;
	}
	return false;
}

const encoding = { encoding: "utf-8" as const };

const spaced = "a value with spaces;$(not-a-shell)";
check(
	"passes arguments without a shell",
	execFileSync(
		"node",
		["-e", "process.stdout.write(process.argv[1])", spaced],
		encoding,
	) === spaced,
);

const explicitEnv = Object.create(null) as Record<string, string>;
explicitEnv.PATH = process.env.PATH ?? "";
Object.defineProperty(explicitEnv, "MARKER", {
	enumerable: true,
	get(): string {
		return "explicit-value";
	},
});
const envOut = execFileSync(
	"node",
	["-e", "process.stdout.write(process.env.MARKER + '|' + String(process.env.HOME))"],
	{ ...encoding, env: explicitEnv },
);
check("uses the explicit enumerable environment", envOut === "explicit-value|undefined");

const cwdOut = execFileSync("node", ["-e", "process.stdout.write(process.cwd())"], {
	...encoding,
	cwd: "/",
});
check("uses cwd", cwdOut === "/");

const nonzero = errorFrom(() =>
	execFileSync(
		"node",
		["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
		encoding,
	),
);
check(
	"reports nonzero status and captured streams",
	nonzero.status === 7 &&
		nonzero.signal === null &&
		nonzero.stdout === "out" &&
		nonzero.stderr === "err",
);

const missing = errorFrom(() =>
	execFileSync("maligator-definitely-missing-executable", [], encoding),
);
check(
	"reports launch errors",
	missing.code === "ENOENT" && missing.status === null && missing.signal === null,
);

check(
	"rejects NUL in executable",
	throws(() => execFileSync("node\0ignored")),
);
check(
	"rejects NUL in arguments",
	throws(() => execFileSync("node", ["-e", "ignored\0suffix"])),
);
check(
	"rejects NUL in cwd",
	throws(() => execFileSync("node", [], { cwd: "/\0ignored" })),
);
check(
	"rejects NUL in environment names",
	throws(() => execFileSync("node", [], { env: { ["BAD\0NAME"]: "value" } })),
);
check(
	"rejects NUL in environment values",
	throws(() => execFileSync("node", [], { env: { BAD: "value\0suffix" } })),
);

const signaled = errorFrom(() =>
	execFileSync("node", ["-e", "process.kill(process.pid, 'SIGTERM')"], encoding),
);
check(
	"reports terminating signals",
	signaled.status === null && signaled.signal === "SIGTERM",
);

const chunkCount = 512;
const dual = errorFrom(() =>
	execFileSync(
		"node",
		[
			"-e",
			"const fs=require('node:fs'),b='x'.repeat(4096);" +
				`for(let i=0;i<${chunkCount};i++)fs.writeSync(2,b);` +
				`for(let i=0;i<${chunkCount};i++)fs.writeSync(1,b);process.exit(9)`,
		],
		encoding,
	),
);
check(
	"drains large stdout and stderr concurrently",
	dual.status === 9 &&
		dual.stdout?.length === chunkCount * 4096 &&
		dual.stderr?.length === chunkCount * 4096,
);

check(
	"supports ignored stdio",
	execFileSync("node", ["-e", "process.stdout.write('discarded')"], {
		stdio: "ignore",
	}) === null,
);
check(
	"supports inherited stdio",
	execFileSync("node", ["-e", ""], { stdio: "inherit" }) === null,
);
check(
	"decodes captured UTF-8 stdout",
	execFileSync("node", ["-e", "process.stdout.write('h\\u00e9llo')"], encoding) ===
		"héllo",
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log(`FAIL: ${name}`);
	}
}
console.log(`RESULT ${passed}/${results.length}`);
