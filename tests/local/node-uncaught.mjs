// Node's uncaught-exception and unhandled-rejection pipeline, ending in a fatal throw.
process.on("exit", (code) => console.log("exit", code));
process.on("uncaughtExceptionMonitor", (error, origin) =>
	console.log("monitor", error.message, origin),
);
process.on("uncaughtException", (error, origin) =>
	console.log("caught", error.message, origin),
);
setTimeout(() => {
	throw new Error("from a timer");
}, 1);
setTimeout(() => {
	process.on("unhandledRejection", (reason, promise) =>
		console.log("unhandled", reason.message, promise instanceof Promise),
	);
	Promise.reject(new Error("rejected"));
}, 5);
setTimeout(() => {
	process.removeAllListeners("unhandledRejection");
	Promise.reject(new Error("rejected without a listener"));
}, 10);
setTimeout(() => {
	process.removeAllListeners("uncaughtException");
	process.setUncaughtExceptionCaptureCallback((error) =>
		console.log("captured", error.message),
	);
	setTimeout(() => {
		throw new Error("captured throw");
	}, 1);
}, 15);
setTimeout(() => {
	process.setUncaughtExceptionCaptureCallback(null);
	console.log("fatal next");
	throw new Error("fatal");
}, 30);
setTimeout(() => console.log("never runs"), 100);
