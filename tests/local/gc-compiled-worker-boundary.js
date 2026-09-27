function readRegion(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	return first.marker + middle.marker + last.marker;
}

let armed = false;
let getterCalls = 0;
const releaseWorker = globalThis.__gcReleaseWorker;
function mutateReceiver() {
	receiver.first = null;
	for (let index = 0; index < 24; index++) {
		receiver["added" + index] = { marker: index };
	}
	receiver.last = { marker: 107 };
}
function readReturnedToken(callback) {
	const token = callback();
	return token.marker === 101 ? token : undefined;
}
function middleGetter() {
	if (armed) {
		getterCalls++;
		mutateReceiver();
		return readReturnedToken(releaseWorker);
	}
	return { marker: 101 };
}
const receiver = {
	first: { marker: 97 },
	get middle() {
		return middleGetter();
	},
	last: { marker: 103 },
};

for (let index = 0; index < 16; index++) {
	if (readRegion(receiver) !== 301) throw new Error("region warmup changed");
}

globalThis.__gcReceiver = receiver;
globalThis.__gcGetter = readReturnedToken;
globalThis.__gcRun = function runWorkerBoundary() {
	armed = true;
	const result = readRegion(receiver);
	if (result !== 305 || getterCalls !== 1) {
		throw new Error(`worker boundary result ${result}, getter calls ${getterCalls}`);
	}
	return result;
};
