// Looping functions reached through calls the compiler cannot resolve, with Number
// arguments and with every argument shape that has to keep the canonical body.

const lines = [];

function Digits(values) {
	this.array = values;
}
function multiplyAdd(i, x, w, j, c, n) {
	const source = this.array;
	const target = w.array;
	const low = x & 0x3fff;
	const high = x >> 14;
	while (--n >= 0) {
		let l = source[i] & 0x3fff;
		const h = source[i++] >> 14;
		const m = high * l + h * low;
		l = low * l + ((m & 0x3fff) << 14) + target[j] + c;
		c = (l >> 28) + (m >> 14) + high * h;
		target[j++] = l & 0xfffffff;
	}
	return c;
}
const install = (method) => {
	Digits.prototype.multiplyAdd = method;
};
install(multiplyAdd);

const a = new Digits([0x1234567, 0xfedcba9, 0x7777777, 3]);
const w = new Digits([1, 2, 3, 4, 5, 6]);
lines.push(
	JSON.stringify([
		a.multiplyAdd(0, 0x9abcdef, w, 1, 7, 4),
		w.array,
		a.multiplyAdd(1, 0x10, w, 0, -0, 2),
		a.multiplyAdd(0, 5, w, 0, 0.5, 1),
		a.multiplyAdd(0, 5, w, 0, NaN, 1),
		a.multiplyAdd(0, 5, w, 0, 0, 0),
		a.multiplyAdd(0, 5, w, 0, 0, -1),
	]),
);

const order = [];
const counted = (label, value) => ({
	valueOf() {
		order.push(label);
		return value;
	},
});
lines.push(
	JSON.stringify([
		a.multiplyAdd("1", 5, w, 0, 0, 1),
		a.multiplyAdd(0, 5, w, "2", 0, 1),
		a.multiplyAdd(0, 5, w, 0, "3", 1),
		a.multiplyAdd(0, 5, w, 0, 0, "2"),
		a.multiplyAdd(
			counted("i", 0),
			5,
			w,
			counted("j", 1),
			counted("c", 2),
			counted("n", 2),
		),
		order,
		String(a.multiplyAdd(0, 5, w, 0, 1n, 0)),
		a.multiplyAdd(0, 5, w, 0),
		a.multiplyAdd(0, 5, w, 0, 0, 1, "extra"),
	]),
);

function sumTo(n) {
	let total = 0;
	while (n-- > 0) total += n;
	return total;
}
function Counter(n) {
	for (let i = 0; i < n; i++) this[i] = i * 2;
}
function receiverKind(n) {
	let steps = 0;
	while (n-- > 0) steps++;
	return `${typeof this} ${steps}`;
}
function strictReceiver(n) {
	"use strict";
	let steps = 0;
	while (n-- > 0) steps++;
	return `${typeof this} ${steps}`;
}
function failsInLoop(n, items) {
	let total = 0;
	for (let i = 0; i < n; i++) total += items[i].weight;
	return total;
}
function countDown(n) {
	let calls = 1;
	for (let i = 0; i < 1; i++) if (n > 0) calls += countDown(n - 1);
	return calls;
}
function reassigned(n) {
	let text = "";
	for (let i = 0; i < 2; i++) {
		text += n;
		n = `${n}!`;
	}
	return text;
}
const indirect = [sumTo, receiverKind, strictReceiver, countDown, reassigned];
let error;
try {
	failsInLoop(3, [{ weight: 1 }, { weight: 2 }]);
} catch (caught) {
	error = `${caught.constructor.name}`;
}
lines.push(
	JSON.stringify([
		indirect[0](10),
		indirect[0](2.5),
		Object.keys(new Counter(3)),
		indirect[1](3),
		indirect[2](3),
		indirect[2].call(7, 2),
		error,
		indirect[3](20),
		indirect[4](1.5),
	]),
);

let total = 0;
for (let round = 0; round < 3000; round++) {
	const digits = new Digits([round & 0xfffffff, 0x2345678, 0x3456789]);
	const out = new Digits([0, 0, 0, 0]);
	total =
		(total + digits.multiplyAdd(0, round * 31, out, 0, 0, 3) + out.array[2]) & 0xfffffff;
	total = (total + indirect[0](round & 15)) & 0xfffffff;
}
lines.push(`total ${total}`);

console.log(lines.join("\n"));
