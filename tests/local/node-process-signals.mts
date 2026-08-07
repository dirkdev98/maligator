// POSIX signal delivery through `process` (node surface). Built + run by
// tests/native/node-process-events.test.ts, which picks a mode with
// NODE_SIGNAL_MODE, waits for the `READY` line, then sends signals.
//
// Every mode keeps the event loop alive with an interval, because a signal
// listener — like Node's unref'd signal handle — does not retain the loop on its
// own. The interval doubles as a watchdog so a lost signal fails fast instead of
// hanging the runner.

const mode = process.env.NODE_SIGNAL_MODE ?? "deliver";
const received: Array<string> = [];

function record(signal: string): void {
	received.push(signal);
	console.log("SIGNAL " + signal + " " + received.length);
}

function finish(): void {
	console.log("DONE " + received.join(","));
	process.exit(0);
}

function onInterrupt(signal: string): void {
	record(signal);
}

function onTerminate(signal: string): void {
	record(signal);
	finish();
}

switch (mode) {
	case "deliver":
		// Two SIGINTs (repeat delivery to a live listener) then a SIGTERM (a second
		// signal number, and the exit path).
		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onTerminate);
		break;
	case "once":
		// The one-shot must run exactly once and then restore the default action,
		// so the runner's second SIGINT terminates the process.
		process.once("SIGINT", onInterrupt);
		break;
	case "removed":
		// off() drops the only listener, so SIGTERM must terminate by default.
		process.on("SIGTERM", onTerminate);
		process.off("SIGTERM", onTerminate);
		console.log("LISTENERS " + process.listenerCount("SIGTERM"));
		break;
	case "remove-all":
		// removeAllListeners() must reach the signal bookkeeping too.
		process.on("SIGTERM", onTerminate);
		process.on("SIGINT", onInterrupt);
		process.removeAllListeners();
		console.log("LISTENERS " + process.listenerCount("SIGTERM"));
		break;
	case "no-before-exit-on-signal":
		// A fatal signal terminates the process without draining the loop, so the
		// beforeExit listener must never run.
		process.on("beforeExit", () => console.log("BEFORE_EXIT"));
		break;
	case "no-before-exit-on-throw":
		// An uncaught top-level exception is a fatal error, so the loop must not
		// hand it a clean drain. Nothing below this case runs.
		process.on("beforeExit", () => console.log("BEFORE_EXIT"));
		throw new Error("fatal-top-level");
	case "no-before-exit-on-exit":
		process.on("beforeExit", () => console.log("BEFORE_EXIT"));
		setTimeout(() => {
			console.log("EXITING");
			process.exit(7);
		}, 10);
		break;
	default:
		console.log("UNKNOWN_MODE " + mode);
		process.exit(9);
}

let ticks = 0;
const keepAlive = setInterval(() => {
	ticks++;
	if (ticks > 200) {
		clearInterval(keepAlive);
		console.log("WATCHDOG " + received.join(","));
		process.exit(8);
	}
}, 25);

console.log("READY " + mode);
