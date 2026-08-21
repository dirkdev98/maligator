function deadLeft() {
	return deadRight();
}

function deadRight() {
	return deadLeft();
}

// These unreachable bodies cover every row kind whose metadata is rebased.
function deadCapture() {
	let value = 1;
	return () => ++value;
}

class DeadPrivate {
	#value = 1;
	read() {
		return this.#value;
	}
}

function* deadGenerator() {
	yield new DeadPrivate().read();
}

async function deadAsync() {
	return deadCapture()();
}

function live(value) {
	return value + 1;
}

function liveThroughCall(value) {
	return live(value);
}

function makeCounter(value) {
	return () => ++value;
}

class LivePrivate {
	#value;
	constructor(value) {
		this.#value = value;
	}
	read() {
		return this.#value;
	}
}

function* liveGenerator() {
	yield 20;
	yield 22;
}

async function liveAsync(value) {
	return await value;
}

const counter = makeCounter(40);
const box = new LivePrivate(counter());
const values = liveGenerator();
const first = values.next().value;
const second = values.next().value;
const asyncValue = await liveAsync(box.read() + 1);
const passed =
	liveThroughCall.call(undefined, asyncValue - 1) === 42 && first + second === 42;
console.log(`RESULT ${passed ? 1 : 0}/1`);
