"use strict";

function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
	}
}

class Temperature {
	#celsius = 0;
	get fahrenheit() {
		return this.#celsius * 1.8 + 32;
	}
	set fahrenheit(value) {
		this.#celsius = (value - 32) / 1.8;
	}
}

class Thermostat extends Temperature {}

function assign(target, value) {
	return (target.fahrenheit = value);
}

const temperature = new Temperature();
let total = 0;
for (let i = 0; i < 200; i++) {
	expectValue(
		assign(temperature, 212),
		212,
		"an assignment evaluates to its right-hand side",
	);
	total += temperature.fahrenheit;
}
expectValue(total, 200 * 212, "the setter reached the receiver's private field");

const thermostat = new Thermostat();
for (let i = 0; i < 50; i++) assign(thermostat, 50);
expectValue(thermostat.fahrenheit, 50, "a setter two prototypes up");

const calls = [];
const holder = {
	set value(next) {
		calls.push(`first:${next}`);
	},
};
const receivers = [Object.create(holder), Object.create(holder)];
function store(index, next) {
	receivers[index].value = next;
}
for (let i = 0; i < 4; i++) store(i & 1, i);
Object.defineProperty(holder, "value", {
	set(next) {
		calls.push(`second:${next}`);
	},
	configurable: true,
});
store(0, 4);
Object.defineProperty(receivers[1], "value", { value: 0, writable: true });
store(1, 5);
expectValue(receivers[1].value, 5, "an own data property shadows the setter");
Object.setPrototypeOf(receivers[0], {
	set value(next) {
		calls.push(`third:${next}`);
	},
});
store(0, 6);
expectValue(
	calls.join(","),
	"first:0,first:1,first:2,first:3,second:4,third:6",
	"redefinitions, shadowing and a new prototype take effect",
);

const getterOnly = Object.create({
	get value() {
		return 1;
	},
});
let rejected = 0;
for (let i = 0; i < 3; i++) {
	try {
		getterOnly.value = i;
	} catch (error) {
		if (error instanceof TypeError) rejected++;
	}
}
expectValue(rejected, 3, "a strict assignment to a getter-only accessor throws");

const throwing = Object.create({
	set value(next) {
		throw new RangeError(`no ${next}`);
	},
});
let thrown = "";
for (let i = 0; i < 3; i++) {
	try {
		throwing.value = i;
	} catch (error) {
		thrown += error.message;
	}
}
expectValue(thrown, "no 0no 1no 2", "a throwing setter propagates");

let frozenCalls = 0;
const frozen = Object.freeze(
	Object.create({
		set value(next) {
			frozenCalls += next;
		},
	}),
);
for (let i = 1; i <= 4; i++) frozen.value = i;
expectValue(frozenCalls, 10, "an inherited setter runs for a frozen receiver");

console.log("native-inherited-setters PASS");
