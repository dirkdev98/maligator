function privateArray(x) {
	const a = [1, 2];
	a.push(x);
	const last = a.pop();
	delete a[1];
	a.length = 1;
	return [last, a[0], a.length, 1 in a].join(":");
}
function escape(x, sink) {
	const a = [1, 2];
	a.push(x);
	a.pop();
	a[0] = x;
	sink(a);
	return a;
}
for (let i = 0; i < 3; i++) console.log(privateArray(i));
let observed;
const first = escape(42, (a) => {
	observed = a;
	a.push(9);
});
const second = escape(42, () => {});
console.log(first === observed, first !== second, first.join(":"), second.join(":"));

let calls = 0;
const key = {
	toString() {
		calls++;
		return "0";
	},
};
const from = {
	valueOf() {
		calls++;
		observed[0] = 11;
		return 0;
	},
};
const a = escape(8, (value) => {
	observed = value;
});
console.log(a[key], a.includes(11, from), calls, a[0]);

function readonly() {
	const value = [1, 2];
	Object.defineProperty(value, "1", { writable: false });
	try {
		value[0] = 9;
		value[1] = 7;
	} catch (error) {
		console.log(error instanceof TypeError, value.join(":"));
	} finally {
		console.log(value.length, value[0]);
	}
}
readonly();

function* suspended() {
	const value = [1];
	value.push(2);
	yield value;
	value.push(3);
	yield value;
}
const generator = suspended();
const yielded = generator.next().value;
yielded[0] = 4;
const resumed = generator.next().value;
console.log(yielded === resumed, resumed.join(":"), generator.next().done);

async function waiting() {
	const value = { x: 1 };
	value.x = 2;
	await 0;
	value.x++;
	return value;
}
console.log((await waiting()).x);

function recursive(n) {
	const value = [n];
	value.push(n + 1);
	if (n > 0) {
		const inner = recursive(n - 1);
		console.log(value !== inner, value.join(":"));
	}
	return value;
}
recursive(2);
function nonIndexProperty(value) {
	const array = [1, 2];
	array["4294967295"] = value;
	array["9007199254740992"] = value;
	array.length = 0;
	return [array.length, array["4294967295"], array["9007199254740992"]];
}
console.log(nonIndexProperty(42).join(":"));
const child = {};
const cycle = { child };
cycle.self = cycle;
const aliases = [cycle, cycle];
console.log(aliases[0] === aliases[1], cycle.self === cycle, cycle.child === child);
const weak = new WeakMap();
weak.set(cycle, 42);
console.log(weak.get(aliases[1]), new WeakRef(cycle).deref() === cycle);
