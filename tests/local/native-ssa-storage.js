const gc = globalThis.__mal_collect_garbage ?? (() => {});
globalThis.makeStorageValue = (value) => ({ value, padding: new Array(300).fill(value) });

function* wideHolder() {
	globalThis.makeStorageValue(1);
	globalThis.makeStorageValue(2);
	globalThis.makeStorageValue(3);
	globalThis.makeStorageValue(4);
	globalThis.makeStorageValue(5);
	globalThis.makeStorageValue(6);
	globalThis.makeStorageValue(7);
	globalThis.makeStorageValue(8);
	const held = globalThis.makeStorageValue(99);
	try {
		yield "ready";
		yield held.value;
	} finally {
		console.log("finally", held.value, held.padding.length);
	}
}

async function wideAsync(gate) {
	globalThis.makeStorageValue(1);
	globalThis.makeStorageValue(2);
	globalThis.makeStorageValue(3);
	globalThis.makeStorageValue(4);
	globalThis.makeStorageValue(5);
	globalThis.makeStorageValue(6);
	globalThis.makeStorageValue(7);
	globalThis.makeStorageValue(8);
	const held = globalThis.makeStorageValue(77);
	await gate;
	return held.value + held.padding.length;
}

const suspended = wideHolder();
console.log(suspended.next().value);
gc();
console.log(suspended.next().value);
gc();
try {
	suspended.throw(new Error("resume-throw"));
} catch (error) {
	console.log(error.message);
}
gc();
console.log(suspended.next().done);

let openGate;
const gate = new Promise((resolve) => (openGate = resolve));
wideAsync(gate).then((value) => console.log("async", value));
setTimeout(() => {
	gc();
	openGate();
}, 0);
