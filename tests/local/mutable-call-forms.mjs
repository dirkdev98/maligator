// Function.prototype.call, apply and bind sites and spread Array literal arguments
// while the primordials are intact, then with them replaced before and during the
// loops and restored again.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

const FunctionPrototype = Function.prototype;
const originalCall = FunctionPrototype.call;
const originalApply = FunctionPrototype.apply;
const originalBind = FunctionPrototype.bind;
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const originalArrayNext = ArrayIteratorPrototype.next;
const originalArrayIterator = Array.prototype[Symbol.iterator];
const replaced = { call: 0, apply: 0, bind: 0, next: 0, iterator: 0 };

function receiverCall(prefix, value) {
	return prefix + value + this.offset;
}
function positional(first, second, third) {
	return first * 3 + second * 5 + (third ?? 7);
}
const receiver = { offset: 11 };

function forms(rounds, observe) {
	let total = 0;
	const bound = receiverCall.bind(receiver, 5);
	for (let index = 0; index < rounds; index++) {
		observe(index);
		const value = index & 63;
		total += receiverCall.call(receiver, 2, value);
		total += receiverCall.apply(receiver, [3, value]);
		total += bound(value);
		total += positional(...[value, index & 7, 13]);
	}
	return total;
}
// Every caller reaches the loop through this, so it stays one site.
const runners = [forms];
const quiet = () => {};

const loops = 40;
const rounds = 64;
let warm = 0;
for (let round = 0; round < loops; round++) warm += runners[0](rounds, quiet);
record("warm", warm);
record("loops", loops);
record("rounds", rounds);

const replacedCall = function (thisArgument, ...list) {
	replaced.call++;
	return Reflect.apply(this, thisArgument, list) + 1;
};
const replacedApply = function (thisArgument, list) {
	replaced.apply++;
	return Reflect.apply(this, thisArgument, Array.from(list)) * 2;
};
const replacedBind = function (thisArgument, ...prefix) {
	replaced.bind++;
	const target = this;
	return (...list) => Reflect.apply(target, thisArgument, [...prefix, ...list]) - 1;
};

// Replaced before the loop runs.
FunctionPrototype.call = replacedCall;
FunctionPrototype.apply = replacedApply;
FunctionPrototype.bind = replacedBind;
record("replaced", runners[0](16, quiet));
FunctionPrototype.call = originalCall;
FunctionPrototype.apply = originalApply;
record("bound-before", runners[0](16, quiet));
FunctionPrototype.bind = originalBind;
record("restored", runners[0](16, quiet));

// Replaced from inside the loop, after its bound function exists, then restored.
record(
	"inside",
	runners[0](16, (index) => {
		if (index === 4) {
			FunctionPrototype.call = replacedCall;
			FunctionPrototype.apply = replacedApply;
			FunctionPrototype.bind = replacedBind;
		}
		if (index === 11) {
			FunctionPrototype.call = originalCall;
			FunctionPrototype.apply = originalApply;
			FunctionPrototype.bind = originalBind;
		}
	}),
);
record("replaced.calls", `${replaced.call},${replaced.apply},${replaced.bind}`);

// The spread literal's iterator protocol, replaced from inside the loop.
record(
	"spread-inside",
	runners[0](16, (index) => {
		if (index === 6)
			ArrayIteratorPrototype.next = function () {
				replaced.next++;
				const step = Reflect.apply(originalArrayNext, this, []);
				return step.done ? step : { value: step.value + 100, done: false };
			};
		if (index === 12) ArrayIteratorPrototype.next = originalArrayNext;
	}),
);
Array.prototype[Symbol.iterator] = function () {
	replaced.iterator++;
	return Reflect.apply(
		originalArrayIterator,
		[...Reflect.apply(originalArrayIterator, this, [])].reverse(),
		[],
	);
};
record("spread-iterator", runners[0](16, quiet));
Array.prototype[Symbol.iterator] = originalArrayIterator;
record("spread.calls", `${replaced.next},${replaced.iterator}`);
record("final", runners[0](16, quiet));

console.log(results.join("\n"));
