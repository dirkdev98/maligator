// Broad promise/microtask benchmark: long dependent chains, high fan-out on one
// pending promise, Promise.all, thenable assimilation, rejection recovery, and
// repeated await. Bounded and deterministic; prints one checksum shared with V8.

function chainWork(count) {
	let promise = Promise.resolve(1);
	for (let i = 0; i < count; i++) {
		promise = promise.then((value) => (value * 33 + i) % 1000000007);
	}
	return promise;
}

function fanoutWork(count) {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const outputs = [];
	for (let i = 0; i < count; i++) {
		outputs.push(gate.then((value) => value + i));
	}
	const joined = Promise.all(outputs);
	release(17);
	return joined;
}

async function awaitWork(count) {
	let sum = 0;
	for (let i = 0; i < count; i++) {
		sum = (sum + (await (i & 7))) % 1000000007;
	}
	return sum;
}

const thenable = {
	then(resolve) {
		resolve(12345);
	},
};

Promise.all([
	chainWork(12000),
	fanoutWork(4000),
	awaitWork(2000),
	Promise.resolve(thenable),
	Promise.reject(99).catch((value) => value + 1),
]).then((values) => {
	let checksum = values[0] + values[2] + values[3] + values[4];
	for (let i = 0; i < values[1].length; i++) {
		checksum = (checksum + values[1][i]) % 1000000007;
	}
	console.log(checksum);
});
