const process = globalThis.process;
const childProcess = process.getBuiltinModule("node:child_process");
const perf = process.getBuiltinModule("node:perf_hooks");
const util = process.getBuiltinModule("node:util");
const os = process.getBuiltinModule("node:os");
const mode = process.env.UPM_PROCESS_MODE;
if (mode === "throw-spawn") {
	const child = childProcess.spawn("sh", ["-c", "exit 0"], { stdio: "inherit" });
	child.on("spawn", () => {
		console.log("SPAWN_THROW");
		throw new Error("spawn listener failure");
	});
	child.on("exit", () => console.log("UNEXPECTED_EXIT"));
} else if (mode === "observer") {
	perf.monitorEventLoopDelay({ resolution: 1 }).enable();
	console.log("OBSERVER_READY");
} else if (mode === "style") {
	console.log(
		JSON.stringify(util.styleText(["bold", "red"], "hello", { stream: process.stdout })),
	);
	console.log(
		JSON.stringify(util.styleText("green", "forced", { validateStream: false })),
	);
} else if (mode === "commands") {
	let asynchronous = false;
	const missing = childProcess.spawn("/maligator-upm-command-does-not-exist", [], {
		stdio: "inherit",
	});
	missing.on("error", (error) =>
		console.log("ERROR", error.code, asynchronous, error.syscall.includes("spawn ")),
	);
	missing.on("close", (code, signal) => console.log("ERROR_CLOSE", code, signal));
	const command = childProcess.spawn(
		"sh",
		["-c", 'printf "CHILD %s %s\\n" "$UPM_VALUE" "$PWD"; sleep 0.04; exit 7'],
		{
			cwd: process.env.UPM_CHILD_CWD,
			env: { PATH: process.env.PATH, UPM_VALUE: "inherited" },
			stdio: "inherit",
		},
	);
	console.log("PID", command.pid > 0, command.exitCode === null);
	command.on("exit", (code, signal) => {
		console.log("EXIT", code, signal, command.exitCode, command.signalCode);
		const killed = childProcess.spawn("sh", ["-c", "exec sleep 2"], { stdio: "inherit" });
		killed.on("spawn", () => console.log("KILL", killed.kill("SIGTERM"), killed.killed));
		killed.on("exit", (status, termination) =>
			console.log("SIGNAL", status, termination),
		);
	});
	command.on("spawn", () => {
		const nested = childProcess.spawn("sh", ["-c", "exit 3"], { stdio: "inherit" });
		nested.on("exit", (code) => console.log("NESTED", code));
	});
	setTimeout(() => console.log("TIMER_WHILE_CHILD"), 5);
	asynchronous = true;
} else {
	console.log(
		"CPU",
		navigator.hardwareConcurrency,
		navigator.hardwareConcurrency === os.availableParallelism(),
	);
	const before = process.memoryUsage();
	const buffer = new ArrayBuffer(131072);
	new Uint8Array(buffer)[0] = 1;
	const after = process.memoryUsage();
	console.log(
		"MEMORY",
		before.rss > 0,
		before.heapUsed > 0,
		before.heapTotal >= before.heapUsed,
		after.arrayBuffers >= before.arrayBuffers + 131072,
		after.external >= after.arrayBuffers,
		process.memoryUsage.rss() > 0,
		buffer.byteLength,
	);
	console.log("REPORT", process.report.getReport().header.platform === process.platform);
	const histogram = perf.monitorEventLoopDelay({ resolution: 1 });
	console.log("ENABLE", histogram.enable(), histogram.enable());
	setTimeout(() => {
		const end = Date.now() + 35;
		while (Date.now() < end) {}
	}, 5);
	setTimeout(() => {
		console.log(
			"LAG",
			histogram.max >= 20000000,
			histogram.percentile(50) > 0,
			histogram.percentile(99) <= histogram.max,
			histogram.disable(),
			histogram.disable(),
		);
		histogram.reset();
		console.log("RESET", histogram.max, histogram.count);
		console.log(
			"RESOURCES",
			process.getActiveResourcesInfo().every((name) => typeof name === "string"),
		);
	}, 60);
}
