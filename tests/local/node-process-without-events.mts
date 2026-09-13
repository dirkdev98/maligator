import importedProcess, { emit as importedEmit, on as importedOn } from "node:process";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

check("default export is the global process", importedProcess === process);
check("named on is process.on", importedOn === process.on);
check("named emit is process.emit", importedEmit === process.emit);

let observed = 0;
check("on returns process", process.on("tick", () => observed++) === process);
check("emit reports a listener ran", process.emit("tick") === true);
check("the listener ran", observed === 1);
process.removeAllListeners("tick");
check("the listener was removed", process.emit("tick") === false);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}
console.log("RESULT " + passed + "/" + results.length);
