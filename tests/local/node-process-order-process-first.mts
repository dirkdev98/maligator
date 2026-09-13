// The process installer must materialize %EventEmitter% when node:process is first.

import { EventEmitter } from "node:events";
import importedProcess, { on as importedOn } from "node:process";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

check("default export is the global process", importedProcess === process);
check("process inherits EventEmitter", process instanceof EventEmitter);
check(
	"prototype is EventEmitter.prototype",
	Object.getPrototypeOf(process) === EventEmitter.prototype,
);
check("named on is EventEmitter.prototype.on", importedOn === EventEmitter.prototype.on);
check(
	"process.on is EventEmitter.prototype.on",
	process.on === EventEmitter.prototype.on,
);

const emitter = new EventEmitter();
let shared = 0;
emitter.on("tick", () => shared++);
process.on("tick", () => (shared += 10));
emitter.emit("tick");
process.emit("tick");
check("both emitters dispatch through the same machinery", shared === 11);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}
console.log("RESULT " + passed + "/" + results.length);
