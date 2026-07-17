let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

const Events = require("events");
const CanonicalEvents = require("node:events");
check(Events === CanonicalEvents, "bare/canonical identity");
check(Events === Events.EventEmitter, "CommonJS constructor export");

const emitter = new Events();
const calls = [];
function regular(value) {
	calls.push("regular:" + value);
}
function once(value) {
	calls.push("once:" + value);
}
emitter.on("data", regular);
emitter.prependOnceListener("data", once);
check(emitter.emit("data", "a") === true, "first emit");
emitter.emit("data", "b");
check(calls.join(",") === "once:a,regular:a,regular:b", "listener behavior");
check(emitter.listenerCount("data") === 1, "listener count");
check(emitter.listeners("data")[0] === regular, "listeners identity");
check(emitter.removeListener("data", regular) === emitter, "remove chaining");
check(emitter.emit("data", "c") === false, "removed listener");

const symbolEvent = Symbol("cjs");
emitter.once(symbolEvent, regular);
check(emitter.rawListeners(symbolEvent)[0].listener === regular, "raw once listener");
check(emitter.eventNames()[0] === symbolEvent, "symbol event name");
emitter.removeAllListeners();
check(emitter.eventNames().length === 0, "remove all");
check(emitter.setMaxListeners(Infinity).getMaxListeners() === Infinity, "max listeners");

let handled = false;
emitter.once("error", () => {
	handled = true;
});
emitter.emit("error", new Error("handled"));
check(handled, "handled error");

console.log("RESULT " + passed + "/" + total);
