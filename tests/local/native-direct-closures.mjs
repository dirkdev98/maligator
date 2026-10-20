// Nested functions that are only ever called need no function object: callers
// rebuild the creation environment from the scope that owns them. Each case
// below varies how that scope is reached, or adds a use that observes the
// object and must keep it.
const log = [];

const moduleBias = 1;

function relate(source, target) {
	let depth = 0;
	const seen = [];
	// Captures only this activation: a single tagged owner.
	function mark(value) {
		seen.push(value);
		return seen.length;
	}
	// Captures this activation and the module scope: a complete chain.
	function isRelated(a, b) {
		depth++;
		if (a > b) return isRelated(a - 1, b) + moduleBias;
		return compare(a, b) + mark(a);
	}
	// Captures nothing.
	function compare(a, b) {
		return a < b ? -1 : a === b ? 0 : 1;
	}
	const result = isRelated(source, target);
	return `${result}:${depth}:${seen.join(",")}`;
}

for (let index = 0; index < 4; index++) log.push(relate(index + 3, 2));

function receiverOf(value) {
	let calls = 0;
	function bump(step) {
		calls += step;
		return this === undefined ? "undefined" : typeof this;
	}
	return [bump(value), bump(1), calls].join("/");
}
log.push(receiverOf(2));

function throwing(limit) {
	let attempts = 0;
	function check(value) {
		attempts++;
		if (value > limit) throw new RangeError(`over ${limit}: ${value}`);
		return value;
	}
	function run(values) {
		let total = 0;
		for (const value of values) total += check(value);
		return total;
	}
	try {
		return run([1, 2, 3, 9]);
	} catch (error) {
		const frame = error.stack.split("\n")[1] ?? "";
		return `${error.message} after ${attempts} via ${frame.includes("check") ? "check" : frame}`;
	}
}
log.push(throwing(5));

// Identity-observing uses keep the function object.
function observed() {
	let count = 0;
	function counted() {
		return ++count;
	}
	function named() {
		return counted.name;
	}
	function compared(other) {
		return other === counted;
	}
	function typed() {
		return typeof counted;
	}
	return [
		counted(),
		named(),
		compared(counted),
		typed(),
		[1, 2].map(counted).join("+"),
	].join(" ");
}
log.push(observed());

function argumentsReader() {
	let total = 0;
	function add() {
		for (let index = 0; index < arguments.length; index++) total += arguments[index];
		return arguments.length;
	}
	return [add(1, 2), add(3), total].join(",");
}
log.push(argumentsReader());

// The owner scope here is created behind a capture vector, so a chain-capturing
// closure has to materialize its object and its callers fall back to it.
function outer(outerValue) {
	return function middle(middleValue) {
		return function inner() {
			const innerValue = middleValue + 10;
			return function owner(seed) {
				let state = seed;
				function step(amount) {
					state += amount + outerValue + innerValue;
					return state;
				}
				function twice(amount) {
					step(amount);
					return step(amount) + zero();
				}
				function zero() {
					return 0;
				}
				return twice(seed) + innerValue;
			};
		};
	};
}
const owner = outer(10)(20)();
log.push(owner(1), owner(2));

// A complete scope chain: the activation's parent is exactly the next owner.
function makeCounter(bias) {
	return function count(values) {
		let total = 0;
		function add(value) {
			total += value + bias;
			return total;
		}
		function addAll() {
			for (const value of values) add(value);
			return add(0);
		}
		return addAll();
	};
}
const count = makeCounter(100);
log.push(count([1, 2]), count([5]));

function immediate(values) {
	let product = 1;
	for (const value of values) {
		product = ((factor) => product * factor)(value);
	}
	return product;
}
log.push(immediate([2, 3, 4]));

function recursiveDepth(node) {
	let deepest = 0;
	function visit(current, depth) {
		if (depth > deepest) deepest = depth;
		for (const child of current.children) visit(child, depth + 1);
	}
	visit(node, 1);
	return deepest;
}
const tree = { children: [{ children: [{ children: [] }] }, { children: [] }] };
log.push(recursiveDepth(tree));

console.log(log.join("\n"));
