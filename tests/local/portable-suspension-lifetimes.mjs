import { AsyncLocalStorage } from "node:async_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc");
const storage = new AsyncLocalStorage();
const collected = new Set();
const registry = new FinalizationRegistry((id) => collected.add(id));
const timers = [];
const instances = 8;

function check(value, message) {
	if (!value) throw new Error(message);
}

async function suspend() {
	const live = { value: 31 };
	const text = "carried-" + live.value;
	let number = 1.5;
	for (let i = 0; i < instances; i++) {
		let instance = { id: i, payload: new Uint8Array(1024) };
		registry.register(instance, i);
		storage.run(new WeakRef(instance), () => {
			check(storage.getStore().deref().id === i, "context is live during its call");
			timers.push(setInterval(() => {}, 1_000_000));
		});
		instance = undefined;
	}
	for (let i = 0; i < 4; i++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 0));
		number += 0.5;
	}
	try {
		await Promise.reject("expected");
	} catch (error) {
		check(error === "expected", "rejections reach the suspended handler");
	}
	check(
		live.value === 31 && text === "carried-31" && number === 3.5,
		"live objects, strings and numbers survive suspension",
	);
	if (process.argv.includes("--check-collection")) {
		check(collected.size === instances, "suspended frames release dead temporaries");
	}
	check(
		registry instanceof FinalizationRegistry,
		"the cleanup registry remains reachable",
	);
}

function* generate() {
	const live = { value: 17 };
	const number = 2.5;
	try {
		const received = yield live;
		return live.value + number + received;
	} catch (error) {
		return live.value + number + error;
	}
}

try {
	await suspend();
	for (const reject of [false, true]) {
		const generator = generate();
		check(generator.next().value.value === 17, "yield preserves the caller's value");
		collect();
		const result = reject ? generator.throw(3) : generator.next(3);
		check(
			result.done && result.value === 22.5,
			"generator continuations preserve live values",
		);
	}
	console.log("SUSPENSION LIFETIMES PASS");
} finally {
	for (const timer of timers) clearInterval(timer);
}
