// A direct eval names the bindings in scope at its call, so the program keeps each
// local, capture, module binding and private field it can see observable to it.

let moduleCounter = 0;

function readWriteLocals(code) {
	let local = 1;
	const items = [1, 2, 3];
	const result = eval(code);
	return [local, items.length, result];
}

function bumpModule(step) {
	return eval("moduleCounter += step");
}

function* evalSequence(seed) {
	let state = seed;
	yield eval("state");
	state += 10;
	yield eval("state++");
	yield state;
}

function restViaEval(...values) {
	return eval("values.length * 100 + values[0]");
}

function makeCaptured() {
	let captured = 0;
	return {
		add(step) {
			captured += step;
			return captured;
		},
		peek: () => eval("captured"),
		poke: (code) => eval(code),
	};
}

class Vault {
	#secret = 3;
	read() {
		return eval("this.#secret");
	}
	write(value) {
		eval("this.#secret = value");
	}
}

let checksum = 0;
for (let index = 0; index < 200; index++) {
	checksum += readWriteLocals("local += 1; items.push(local); local * 2")[2];
	checksum += bumpModule(1);
	for (const value of evalSequence(index & 7)) checksum += value;
	checksum += restViaEval(index & 3, 2, 3);
}
const captured = makeCaptured();
for (let index = 0; index < 100; index++) captured.add(1);
captured.poke("captured = 'replaced'");
const vault = new Vault();
let vaultSum = 0;
for (let index = 0; index < 100; index++) {
	vault.write(index);
	vaultSum += vault.read();
}
console.log(
	JSON.stringify([
		checksum,
		moduleCounter,
		readWriteLocals("local = 'changed'; items.length = 0; typeof items"),
		[...evalSequence(5)],
		restViaEval("x"),
		captured.add(1),
		captured.peek(),
		vaultSum,
		vault.read(),
	]),
);
