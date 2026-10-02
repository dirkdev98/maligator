const mode = process.env.UPM_PROCESS_MODE || "normal";

process.on("exit", (code) => {
	console.log("EXIT", code);
	if (mode === "change-exit") process.exitCode = 9;
	setTimeout(() => console.log("EXIT_TIMER_RAN"), 0);
});

if (mode === "explicit") {
	process.exitCode = 7;
	process.exit();
}

if (mode === "change-exit") {
	process.exitCode = 4;
} else if (mode === "epipe") {
	process.stdout.on("error", (error) => console.error("ERROR", error.code));
	setTimeout(() => {
		const accepted = process.stdout.write("broken pipe", (error) => {
			console.error("WRITE_ERROR", error.code);
		});
		console.error("ACCEPTED", accepted);
	}, 30);
} else if (mode === "unref") {
	AbortSignal.timeout(10000);
	const timer = setInterval(() => console.log("UNREF_RAN"), 10000);
	timer.unref();
	console.log("REF_STATE", timer.hasRef());
} else {
	const os = process.getBuiltinModule("os");
	console.log("BUILTIN", os === process.getBuiltinModule("node:os"));
	console.log("UNKNOWN", process.getBuiltinModule("not-a-builtin") === undefined);
	console.log("IDENTITY", process.getBuiltinModule("process") === process);
	console.log("RUNTIME", process.release.name, process.version, process.versions.node);
	console.log(
		"STDIO",
		process.stdin.fd,
		typeof process.stdout.on,
		typeof process.stderr.off,
		typeof process.stdout.columns,
	);
	const previous = process.umask("077");
	console.log("UMASK", process.umask());
	process.umask(previous);
	process.kill(process.pid, 0);
	let invalidSignal = false;
	try {
		process.kill(process.pid, "SIGHUP\0junk");
	} catch {
		invalidSignal = true;
	}
	console.log("SIGNAL_VALIDATION", invalidSignal);
	process.once("SIGHUP", (signal) => console.log("SIGNAL", signal));
	process.kill(process.pid, os.constants.signals.SIGHUP);
	const discarded = setTimeout(() => console.log("CLEARED_RAN"), 5);
	clearTimeout(discarded);
	const timer = setTimeout(function () {
		console.log("TIMER", this === timer);
	}, 10);
	console.log(
		"REF",
		timer.hasRef(),
		timer.unref() === timer,
		timer.hasRef(),
		timer.ref() === timer,
		timer.hasRef(),
	);
	const background = setInterval(() => console.log("BACKGROUND_RAN"), 10000);
	background.unref();
	let synchronous = true;
	process.stdout.write("WRITE\n", "utf8", () => console.log("CALLBACK", synchronous));
	synchronous = false;
	process.exitCode = "3";
	let drains = 0;
	process.on("beforeExit", (code) => {
		console.log("BEFORE", ++drains, code);
		if (drains === 1) setTimeout(() => console.log("RESCHEDULED"), 1);
	});
}
