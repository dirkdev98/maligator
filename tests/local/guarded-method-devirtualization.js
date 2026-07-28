"use strict";

let checks = 0;
function check(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
	checks++;
}

class AddOne {
	constructor(bias = 1) {
		this.bias = bias;
	}
	quote(value) {
		return this.bias + value;
	}
}

class AddTwo {
	quote(value) {
		return value + 2;
	}
}

class AddThree {
	quote(value) {
		return value + 3;
	}
}

function invoke(receiver, value) {
	return receiver.quote(value);
}

class UniqueCalculator {
	compute(value) {
		return value + 1;
	}
}

check(new UniqueCalculator().compute(4) === 5, "unique class method");

const polymorphic = [new AddOne(), new AddTwo(), new AddThree()];
let sum = 0;
for (let i = 0; i < 300; i++) sum += invoke(polymorphic[i % 3], 10);
check(sum === 3600, "three-way class dispatch");

const mutated = new AddOne(4);
const originalQuote = AddOne.prototype.quote;
function replaceDuringArgumentEvaluation() {
	AddOne.prototype.quote = function (value) {
		return value + 50;
	};
	return 6;
}
check(mutated.quote(replaceDuringArgumentEvaluation()) === 10, "retains loaded method");
check(mutated.quote(6) === 56, "observes replacement on next load");
AddOne.prototype.quote = originalQuote;

const shadowed = new AddTwo();
shadowed.quote = function (value) {
	return value + 70;
};
check(invoke(shadowed, 1) === 71, "own shadow falls back");

let proxyGets = 0;
const proxied = new Proxy(new AddOne(5), {
	get(target, key, receiver) {
		proxyGets++;
		return Reflect.get(target, key, receiver);
	},
});
check(invoke(proxied, 2) === 7 && proxyGets >= 2, "proxy Get and this binding");

let accessorGets = 0;
const accessorReceiver = Object.create(AddThree.prototype);
Object.defineProperty(accessorReceiver, "quote", {
	configurable: true,
	get() {
		accessorGets++;
		return AddThree.prototype.quote;
	},
});
check(
	invoke(accessorReceiver, 3) === 6 &&
		invoke(accessorReceiver, 4) === 7 &&
		accessorGets === 2,
	"accessor runs for every method load",
);

class Recursive {
	recurse(value) {
		return value === 0 ? 0 : 1 + this.recurse(value - 1);
	}
}
check(new Recursive().recurse(20) === 20, "recursive method remains bounded");

let loadedBeforeThrow = 0;
const throwingReceiver = {
	get quote() {
		loadedBeforeThrow++;
		return AddTwo.prototype.quote;
	},
};
const argumentError = new Error("argument");
try {
	throwingReceiver.quote(
		(() => {
			throw argumentError;
		})(),
	);
} catch (error) {
	check(
		error === argumentError && loadedBeforeThrow === 1,
		"argument throw after method Get",
	);
}

console.log("guarded-method-devirtualization PASS " + checks);
