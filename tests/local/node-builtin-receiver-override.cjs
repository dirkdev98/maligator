const { EventEmitter } = require("node:events");
const os = require("node:os");

function countListeners(emitter, name) {
	return emitter.listenerCount(name);
}

const original = EventEmitter.prototype.listenerCount;
EventEmitter.prototype.listenerCount = function (name) {
	if (name !== "loader-probe") return original.call(this, name);
	const load = this[process.argv[2]];
	return load.call(this, process.argv[3]) === os ? 1 : 0;
};

console.log(countListeners(process, "loader-probe"));
