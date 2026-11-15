function strictChoice(value) {
	"use strict";
	return value ? 11 : 7;
}

function sloppyChoice(value) {
	return value ? 13 : 5;
}

function sumSloppy(count) {
	let sum = 0;
	for (let index = 0; index < count; index++) sum += strictChoice(index);
	return sum;
}

function sumStrict(count) {
	"use strict";
	let sum = 0;
	for (let index = 0; index < count; index++) sum += sloppyChoice(index);
	return sum;
}

function strictStore(target) {
	"use strict";
	target.value = 9;
}

function sloppyStore(target) {
	target.value = 9;
}

function strictStoreCaller(target) {
	"use strict";
	sloppyStore(target);
	return target.value;
}

function receiver() {
	return this;
}

function reflection(value) {
	return arguments.callee.length + arguments.length + value;
}

function consume(callback) {
	return callback();
}

function captured(seed) {
	const read = () => seed;
	return consume(read);
}

function deferred(values) {
	function first(index) {
		return index > 0 ? second(index - 1) : values[0];
	}
	function second(index) {
		return index > 0 ? first(index - 1) : values[1];
	}
	if (!values) return 0;
	return first(values.length);
}

function dynamic(value) {
	with ({ value: 17 }) {
		return value;
	}
}

const frozen = Object.freeze({ value: 3 });
let rejected;
try {
	strictStore(frozen);
} catch (error) {
	rejected = error.name;
}
console.log(
	JSON.stringify({
		branches: [sumSloppy(30), sumStrict(30)],
		stores: [rejected, strictStoreCaller(frozen)],
		receiver: [receiver.call(null) === globalThis, typeof receiver.call(7)],
		reflection: reflection(11),
		captures: [captured({ value: 19 }).value, captured(23)],
		deferred: [deferred(null), deferred([3, 5, 7])],
		dynamic: dynamic(2),
	}),
);
