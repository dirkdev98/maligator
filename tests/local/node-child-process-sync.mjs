import childProcess, { execFileSync, execSync, spawnSync } from "node:child_process";

const show = (value) =>
	value === null || value === undefined
		? String(value)
		: Buffer.isBuffer(value)
			? `Buffer(${JSON.stringify(value.toString())})`
			: JSON.stringify(value);

const describeResult = (label, result) => {
	console.log(
		label,
		Object.keys(result).join(","),
		"status",
		result.status,
		"signal",
		result.signal,
		"stdout",
		show(result.stdout),
		"stderr",
		show(result.stderr),
		"output",
		result.output === null ? "null" : result.output.map(show).join("|"),
		"pid",
		result.pid > 0 ? "positive" : result.pid,
	);
	if (result.error) {
		const { error } = result;
		console.log(
			` ${label}.error`,
			error instanceof Error,
			error.message,
			Object.keys(error).join(","),
			error.code,
			error.errno < 0,
			error.syscall,
			error.path,
			JSON.stringify(error.spawnargs),
		);
	}
};

const describeThrown = (label, run) => {
	try {
		console.log(label, "returned", show(run()));
	} catch (error) {
		console.log(
			label,
			"threw",
			JSON.stringify(error.message),
			Object.keys(error).join(","),
			"status",
			error.status,
			"signal",
			error.signal,
			"code",
			error.code,
			"stdout",
			show(error.stdout),
			"stderr",
			show(error.stderr),
		);
	}
};

describeResult("buffers", spawnSync("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]));
describeResult("utf8", spawnSync("echo", ["héllo"], { encoding: "utf8" }));
describeResult("hex", spawnSync("printf", ["hi"], { encoding: "hex" }));
describeResult(
	"input",
	spawnSync("cat", { input: "fed through stdin", encoding: "utf8" }),
);
const binary = spawnSync("cat", { input: Buffer.from([0x68, 0x00, 0xff, 0x0a]) });
console.log("buffer input", binary.stdout.toString("hex"));
describeThrown("typed array input", () =>
	execSync("cat", { input: new Uint8Array([0x6f, 0x6b]), encoding: "latin1" }),
);
describeResult(
	"stdio array",
	spawnSync("cat", { input: "x", stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }),
);
describeResult("ignored", spawnSync("echo", ["gone"], { stdio: "ignore" }));
describeResult(
	"shell",
	spawnSync("echo $MAL_CP_VALUE", {
		shell: true,
		env: { MAL_CP_VALUE: "from env", PATH: process.env.PATH },
		encoding: "utf8",
	}),
);
describeResult("cwd", spawnSync("pwd", { cwd: "/", encoding: "utf8" }));
describeResult("signal", spawnSync("/bin/sh", ["-c", "kill -USR1 $$"]));
describeResult("missing", spawnSync("maligator-missing-executable", ["arg"]));
describeResult("timeout", spawnSync("sleep", ["5"], { timeout: 50, encoding: "utf8" }));
describeResult(
	"timeout kill signal",
	spawnSync("sleep", ["5"], { timeout: 50, killSignal: "SIGKILL" }),
);
const overflow = spawnSync("/bin/sh", ["-c", "head -c 4096 /dev/zero; sleep 5"], {
	maxBuffer: 100,
});
console.log(
	"maxBuffer",
	overflow.error?.code,
	overflow.error?.message,
	overflow.status,
	overflow.signal,
);
const unlimited = spawnSync("head", ["-c", "1100000", "/dev/zero"], {
	maxBuffer: Infinity,
});
console.log("unlimited", unlimited.error, unlimited.status, unlimited.stdout.length);

describeThrown("execSync buffer", () => execSync("echo plain"));
describeThrown("execSync utf8", () => execSync("echo a; echo b", { encoding: "utf8" }));
describeThrown("execSync input", () =>
	execSync("tr a-z A-Z", { input: "shout", encoding: "utf8" }),
);
describeThrown("execSync inherit", () => execSync("true", { stdio: "inherit" }));
describeThrown("execSync failure", () =>
	execSync("echo partial; echo broken >&2; exit 2", { stdio: "pipe" }),
);
describeThrown("execSync failure encoded", () =>
	execSync("echo broken >&2; exit 4", { stdio: "pipe", encoding: "utf8" }),
);
describeThrown("execSync signal", () => execSync("kill -9 $$"));
describeThrown("execSync timeout", () => execSync("sleep 5", { timeout: 50 }));
describeThrown("execSync custom shell", () =>
	execSync("echo $0", { shell: "/bin/sh", encoding: "utf8" }),
);
describeThrown("execFileSync failure", () =>
	execFileSync("/bin/sh", ["-c", "exit 5"], { stdio: "pipe" }),
);
describeThrown("execFileSync shell", () =>
	execFileSync("echo", ["joined", "words"], { shell: true, encoding: "utf8" }),
);
describeThrown("execFileSync missing", () =>
	execFileSync("maligator-missing-executable"),
);

console.log(
	"default namespace",
	childProcess.spawnSync === spawnSync,
	childProcess.execSync === execSync,
	childProcess.execFileSync === execFileSync,
);
