const scenario = process.env.GUARDED_LOOP_CASE;
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const events = [];

function calculate(prefix, value) {
	return prefix + value + this.offset;
}

function methodLoop(replacement, mutation, offset) {
	const receiver = { offset: 11, calculate };
	let checksum = 0;
	for (let index = 0; index < 24; index++) {
		if (index === 9) {
			if (mutation === "method") receiver.calculate = replacement;
			if (mutation === "offset") receiver.offset = offset;
			if (mutation === "getter")
				Object.defineProperty(receiver, "offset", {
					get() {
						events.push(index);
						collect();
						return offset;
					},
				});
		}
		checksum += index & 7;
		checksum += receiver.calculate(3, index);
		checksum += index * 2;
	}
	return checksum;
}

function boundLoop(patch) {
	const original = Function.prototype.bind;
	if (patch)
		Function.prototype.bind = function (receiver, prefix) {
			return (value) => `bound:${prefix + value + receiver.offset}`;
		};
	const receiver = { offset: 11, calculate };
	const bound = receiver.calculate.bind(receiver, 5);
	let checksum = 0;
	for (let index = 0; index < 24; index++) {
		checksum += index;
		checksum += bound(index);
		checksum += index & 3;
	}
	Function.prototype.bind = original;
	return checksum;
}

function callbackLoop(patch) {
	const original = Function.prototype.bind;
	if (patch)
		Function.prototype.bind = function (receiver, prefix) {
			return (value) => `bound:${prefix + value + receiver.offset}`;
		};
	let shared = 0;
	const receiver = { offset: 11, calculate };
	const bound = receiver.calculate.bind(receiver, 5);
	const callbacks = Array.from(
		{ length: 4 },
		(_, bias) => (value) => value + bias + shared,
	);
	let checksum = 0;
	for (let index = 0; index < 24; index++) {
		shared = index;
		if (index === 9) shared = "capture:";
		checksum += callbacks[index & 3](index);
		checksum += bound(index);
	}
	Function.prototype.bind = original;
	return checksum;
}

const replacement = new Proxy(calculate, {
	apply(target, receiver, arguments_) {
		events.push(arguments_[1]);
		collect();
		return scenario === "methodString"
			? `value:${arguments_[1]}`
			: Reflect.apply(target, receiver, arguments_);
	},
});
function numberBits(value, offset) {
	return (value * 3 + offset) & 65_535;
}

let checksum;
if (scenario === "cachedNumber") {
	const values = [
		0,
		-0,
		NaN,
		Infinity,
		-Infinity,
		0.25,
		-1.5,
		2 ** 32 + 0.5,
		-(2 ** 32) - 0.5,
		1e50,
		null,
		undefined,
		"16",
		"bad",
	];
	checksum = values.map((value) => [numberBits(value, 7), numberBits(value, "4")]);
} else if (scenario === "methodNumber" || scenario === "methodString")
	checksum = methodLoop(replacement, "method");
else if (scenario === "offset") checksum = methodLoop(replacement, "offset", "field:");
else if (scenario === "getter") checksum = methodLoop(replacement, "getter", "getter:");
else if (scenario === "boundPatched") checksum = callbackLoop(true);
else if (scenario === "callback") checksum = callbackLoop();
else checksum = boundLoop(false);
console.log(JSON.stringify({ checksum, events }));
