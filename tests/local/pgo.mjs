let result = 0;
function add(x) {
	result += x;
}
function argumentFailure() {
	throw 9;
}
function defaults(x = argumentFailure()) {
	add(x);
}
const recursive = function recursive(n) {
	if (n === 0) return 1;
	return recursive(n - 1);
};
function* generator() {
	yield 2;
	yield 3;
}
async function asynchronous() {
	await 1;
	add(4);
}
function callback(x) {
	return x + 1;
}
function spreadTarget(value) {
	if (value !== 8) throw 100;
}
function spreadAfterSetter() {
	Object.defineProperty(Array.prototype, "0", {
		configurable: true,
		set() {
			throw 101;
		},
	});
	try {
		spreadTarget(...[8]);
	} finally {
		delete Array.prototype[0];
	}
}
function Box(x) {
	this.value = x;
}
function tag(strings) {
	return strings[0];
}
class Base {
	constructor() {}
}
class Derived extends Base {
	constructor() {
		super();
	}
}
function run() {
	spreadAfterSetter();
	new Box(3);
	new Derived();
	tag`text`;
	for (let i = 0; i < 3; i++) add(i);
	try {
		add(argumentFailure());
	} catch {}
	try {
		defaults();
	} catch {}
	try {
		null(1);
	} catch {}
	let absent = null;
	absent?.(argumentFailure());
	const iterator = {
		[Symbol.iterator]() {
			return {
				next() {
					throw 7;
				},
			};
		},
	};
	try {
		add(...iterator);
	} catch {}
	recursive(4);
	generator();
	const g = generator();
	add(g.next().value);
	add(g.next().value);
	g.next();
	const values = [1, 2, 3].map(callback);
	add(values[2]);
	asynchronous();
}
run();
console.log(result);
