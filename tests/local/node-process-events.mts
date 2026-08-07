// `process` as an EventEmitter (node surface): export identity, ordinary event
// dispatch, one-shot cleanup, and `beforeExit` rescheduling. Built + run by
// tests/native/node-process-events.test.ts on the host entry.
//
// Prints ordered BEFORE_EXIT markers while the loop drains, then a final
// `RESULT p/t` line from a `beforeExit` listener — the last thing that can run
// before the process leaves the event loop.

import { EventEmitter } from "node:events";
import importedProcess, {
	emit as importedEmit,
	off as importedOff,
	on as importedOn,
	once as importedOnce,
	removeListener as importedRemoveListener,
} from "node:process";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

// --- export identity ---
check("default export is the global process", importedProcess === process);
check("process inherits EventEmitter", process instanceof EventEmitter);
check(
	"prototype is EventEmitter.prototype",
	Object.getPrototypeOf(process) === EventEmitter.prototype,
);
check("named on is process.on", importedOn === process.on);
check("named once is process.once", importedOnce === process.once);
check("named off is process.off", importedOff === process.off);
check("named emit is process.emit", importedEmit === process.emit);
check(
	"named removeListener is process.removeListener",
	importedRemoveListener === process.removeListener,
);
check("on is EventEmitter.prototype.on", process.on === EventEmitter.prototype.on);
check("off aliases removeListener", process.off === process.removeListener);
check("addListener aliases on", process.addListener === process.on);

// --- ordinary events ---
const seen: Array<string> = [];
function first(value: string): void {
	seen.push("first:" + value);
}
function second(value: string): void {
	seen.push("second:" + value);
}

check("on returns process", process.on("custom", first) === process);
process.on("custom", second);
check("listenerCount counts both", process.listenerCount("custom") === 2);
check("emit reports a listener ran", process.emit("custom", "a") === true);
check("both listeners ran in order", seen.join(",") === "first:a,second:a");

seen.length = 0;
process.off("custom", first);
check("off drops one listener", process.listenerCount("custom") === 1);
process.emit("custom", "b");
check("only the remaining listener ran", seen.join(",") === "second:b");

seen.length = 0;
process.once("custom", (value: string) => seen.push("once:" + value));
check("once adds a listener", process.listenerCount("custom") === 2);
process.emit("custom", "c");
check("the one-shot listener ran", seen.join(",") === "second:c,once:c");
check("the one-shot listener was removed", process.listenerCount("custom") === 1);
process.emit("custom", "d");
check("the one-shot listener did not run again", seen.length === 3);

check("eventNames includes custom", process.eventNames().indexOf("custom") >= 0);
check("listeners returns the array", process.listeners("custom").length === 1);
process.removeAllListeners("custom");
check("removeAllListeners clears the event", process.listenerCount("custom") === 0);
check("emit with no listeners is false", process.emit("custom", "e") === false);

// --- listener rooting under allocation churn (drives MAL_GC_STRESS runs) ---
const churn: Array<number> = [];
for (let i = 0; i < 64; i++) {
	const index = i;
	process.on("churn", () => churn.push(index));
	process.once("churn-once", () => churn.push(1000 + index));
	// Allocate between registrations so a stress-mode collection lands mid-array
	// while the listener arrays and once-wrappers are the only thing holding them.
	JSON.parse(JSON.stringify({ index, filler: new Array(16).fill(index) }));
}
process.emit("churn");
process.emit("churn-once");
process.emit("churn-once");
check("every churned listener survived collection", churn.length === 128);
check("churned listeners kept registration order", churn[0] === 0 && churn[63] === 63);
check("churned one-shots ran exactly once", churn[64] === 1000 && churn[127] === 1063);
check("churned one-shots were removed", process.listenerCount("churn-once") === 0);
process.removeAllListeners("churn");
check("churned listeners cleared", process.listenerCount("churn") === 0);

// --- beforeExit ---
// The first two notifications each schedule work, so the loop drains and
// notifies again; the third schedules nothing and the process exits.
let beforeExitCount = 0;
process.on("beforeExit", (code: number) => {
	beforeExitCount++;
	console.log("BEFORE_EXIT " + beforeExitCount + " " + code);
	if (beforeExitCount === 1) {
		setTimeout(() => console.log("RESCHEDULED_TIMER"), 0);
		return;
	}
	if (beforeExitCount === 2) {
		setImmediate(() => console.log("RESCHEDULED_IMMEDIATE"));
		return;
	}
	check("beforeExit repeated for each rescheduled drain", beforeExitCount === 3);
	check("beforeExit receives an exit code", code === 0);
	let passed = 0;
	for (const [name, ok] of results) {
		if (ok) {
			passed++;
		} else {
			console.log("FAIL: " + name);
		}
	}
	console.log("RESULT " + passed + "/" + results.length);
});

setTimeout(() => console.log("INITIAL_TIMER"), 0);
