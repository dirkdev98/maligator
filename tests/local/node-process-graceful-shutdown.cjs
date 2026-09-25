/* oxlint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

// The Express-shaped graceful shutdown: serve until SIGTERM, stop accepting, let
// the close callback run, then leave through `beforeExit` with a zero status.
// Built + run by tests/native/node-process-events.test.ts, which drives a request
// through the server before signalling it.

const { app } = require("../fixtures/express-5/app.js");

const server = app.listen(0, "127.0.0.1", () => {
	console.log("PORT " + server.address().port);
});

let shuttingDown = false;
function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("SHUTDOWN " + signal);
	server.close(() => {
		console.log("CLOSED");
	});
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("beforeExit", () => {
	console.log("BEFORE_EXIT " + (shuttingDown ? "after-shutdown" : "idle"));
});
