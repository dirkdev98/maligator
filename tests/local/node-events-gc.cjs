// Every allocation happens inside one listener that JavaScript emits to, so the collector
// can only run during the emit.
const { EventEmitter } = require("node:events");

const emitter = new EventEmitter();
let checksum = 0;
emitter.on("run", () => {
	let retained = [];
	for (let round = 0; round < 800000; round++) {
		retained.push({ round, text: "x" + round });
		if (retained.length > 64) retained = [];
		checksum += retained.length;
	}
});
emitter.emit("run");
console.log(checksum > 0 ? "node-events-gc PASS" : "node-events-gc FAIL");
