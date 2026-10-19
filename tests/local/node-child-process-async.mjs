import { ChildProcess, exec, execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

function run(label, child) {
	return new Promise((resolve) => {
		const events = [];
		child.on("spawn", () => events.push("spawn"));
		child.on("exit", (code, signal) => events.push(`exit ${code} ${signal}`));
		child.on("error", (error) => events.push(`error ${error.code} ${error.message}`));
		child.on("close", (code, signal) => {
			events.push(`close ${code} ${signal}`);
			console.log(label, events.join(", "));
			resolve();
		});
	});
}

const echo = spawn("/bin/echo", ["hello", "world"]);
console.log("instance", echo instanceof ChildProcess, echo instanceof EventEmitter);
console.log(
	"spawn fields",
	echo.spawnfile,
	JSON.stringify(echo.spawnargs),
	echo.connected,
	typeof echo.pid,
);
console.log(
	"stdio",
	echo.stdio.length,
	echo.stdio[1] === echo.stdout,
	echo.stdin !== null,
);
let echoed = "";
echo.stdout.on("data", (chunk) => {
	echoed += Buffer.isBuffer(chunk) ? `buffer:${chunk}` : chunk;
});
await run("echo", echo);
console.log("echo stdout", JSON.stringify(echoed), echo.exitCode, echo.signalCode);

const cat = spawn("sh", ["-c", "cat; echo err >&2"]);
cat.stdout.setEncoding("utf8");
let catOut = "";
let catErr = "";
cat.stdout.on("data", (chunk) => (catOut += chunk));
cat.stderr.on("data", (chunk) => (catErr += chunk));
cat.stdin.write("piped ");
cat.stdin.end("input");
await run("cat", cat);
console.log("cat", JSON.stringify(catOut), JSON.stringify(catErr));

const big = spawn("sh", ["-c", "head -c 300000 /dev/zero"]);
let bigLength = 0;
big.stdout.on("data", (chunk) => (bigLength += chunk.length));
await run("big", big);
console.log("big length", bigLength);

const shell = spawn("echo $0 shell", {
	shell: true,
	stdio: ["ignore", "pipe", "inherit"],
});
let shellOut = "";
shell.stdout.on("data", (chunk) => (shellOut += chunk));
await run("shell", shell);
console.log("shell", JSON.stringify(shellOut.trim()), shell.stdin);

const env = spawn("sh", ["-c", "echo $MAL_ASYNC_VALUE; pwd"], {
	env: { MAL_ASYNC_VALUE: "set", PATH: process.env.PATH },
	cwd: "/",
});
let envOut = "";
env.stdout.on("data", (chunk) => (envOut += chunk));
await run("env", env);
console.log("env", JSON.stringify(envOut));

const sleeper = spawn("sleep", ["10"], { stdio: "ignore" });
await new Promise((resolve) => sleeper.on("spawn", resolve));
console.log("kill", sleeper.kill("SIGTERM"), sleeper.killed);
await run("killed", sleeper);

const timed = spawn("sleep", ["10"], {
	stdio: "ignore",
	timeout: 50,
	killSignal: "SIGKILL",
});
await run("timeout", timed);

const controller = new AbortController();
const aborted = spawn("sleep", ["10"], { stdio: "ignore", signal: controller.signal });
aborted.on("spawn", () => controller.abort());
aborted.on("error", (error) => console.log("abort error", error.name, error.code));
await run("abort", aborted);

const missing = spawn("mal-missing-command-xyz", ["a"]);
await run("missing", missing);

await new Promise((resolve) => {
	const child = exec("echo out; echo err >&2", (error, stdout, stderr) => {
		console.log("exec ok", error, JSON.stringify(stdout), JSON.stringify(stderr));
		resolve();
	});
	console.log("exec returns", child instanceof ChildProcess);
});

await new Promise((resolve) => {
	exec("echo bad >&2; exit 3", (error, stdout, stderr) => {
		console.log(
			"exec fail",
			error.message.trim(),
			error.code,
			error.killed,
			error.signal,
			error.cmd,
		);
		console.log("exec fail output", JSON.stringify(stdout), JSON.stringify(stderr));
		resolve();
	});
});

await new Promise((resolve) => {
	execFile("/bin/echo", ["buffered"], { encoding: "buffer" }, (error, stdout) => {
		console.log(
			"execFile buffer",
			error,
			Buffer.isBuffer(stdout),
			JSON.stringify(stdout.toString()),
		);
		resolve();
	});
});

await new Promise((resolve) => {
	execFile(
		"sh",
		["-c", "head -c 5000 /dev/zero"],
		{ maxBuffer: 100 },
		(error, stdout) => {
			console.log("maxBuffer", error.code, error.message, stdout.length);
			resolve();
		},
	);
});

await new Promise((resolve) => {
	exec("sleep 10", { timeout: 50 }, (error) => {
		console.log("exec timeout", error.killed, error.signal, error.code);
		resolve();
	});
});

const execAsync = promisify(exec);
const resolved = await execAsync("echo promised");
console.log("promisify exec", JSON.stringify(resolved));
try {
	await promisify(execFile)("sh", ["-c", "echo partial; exit 2"]);
} catch (error) {
	console.log(
		"promisify execFile",
		error.code,
		JSON.stringify(error.stdout),
		JSON.stringify(error.stderr),
	);
}
