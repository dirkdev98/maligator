"use strict";

/* oxlint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

const checks = [];
const events = ["sync"];
let pending = 3;

checks.push(typeof setTimeout === "function");
checks.push(typeof clearTimeout === "function");
checks.push(typeof setImmediate === "function");
checks.push(typeof clearImmediate === "function");

const cancelled = setImmediate(() => events.push("cancelled"));
clearImmediate(cancelled);

setImmediate(
	(value) => {
		events.push("first");
		checks.push(value && value.rooted === 42);
		Promise.resolve().then(() => events.push("microtask"));
		complete();
	},
	{ rooted: 42 },
);

setImmediate(() => {
	events.push("second");
	checks.push(events.indexOf("microtask") < events.indexOf("second"));
	complete();
});

setTimeout(() => {
	events.push("timeout");
	complete();
}, 0);

function complete() {
	if (--pending !== 0) return;
	checks.push(events[0] === "sync");
	checks.push(!events.includes("cancelled"));
	console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);
}
