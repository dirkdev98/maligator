function invoke(target, args) {
	switch (args.length) {
		case 0:
			return target();
		case 1:
			return target(args[0]);
		case 2:
			return target(args[0], args[1]);
		case 3:
			return target(args[0], args[1], args[2]);
		default:
			return target(...args);
	}
}

function strictTarget() {
	"use strict";
	return [this.label, Array.from(arguments, (value) => value.id).join(",")];
}

const first = strictTarget.bind({ label: "first" }, { id: 1 }, { id: 2 });
console.log(JSON.stringify(invoke(first, [{ id: 3 }])));
console.log(
	JSON.stringify(
		invoke(
			first,
			Array.from({ length: 20 }, (_, id) => ({ id })),
		),
	),
);
for (const count of [13, 14]) {
	const boundary = strictTarget.bind(
		{ label: `prefix${count}` },
		...Array.from({ length: count }, (_, id) => ({ id })),
	);
	console.log(JSON.stringify(invoke(boundary, [{ id: 31 }, { id: 32 }, { id: 33 }])));
}
const nested = first.bind({ label: "ignored" }, { id: 3 }, { id: 4 });
console.log(JSON.stringify(invoke(nested, [{ id: 5 }, { id: 6 }, { id: 7 }])));
const wide = nested.bind(
	null,
	...Array.from({ length: 64 }, (_, index) => ({ id: index + 8 })),
);
console.log(JSON.stringify(invoke(wide, [{ id: 12 }, { id: 13 }])));

function sloppyThis() {
	return this;
}
console.log(invoke(sloppyThis.bind(null), []) === globalThis);
console.log(invoke(sloppyThis.bind(23), []).valueOf());
console.log(invoke(Math.max.bind(null, 5), [2, 19]));
console.log(invoke(Function.prototype.call.bind(Math.max, null, 6), [21, 3]));
console.log(invoke(Function.prototype.apply.bind(Math.min, null), [[8, 4, 12]]));

const proxy = new Proxy(strictTarget, {
	apply(target, receiver, args) {
		return ["trap", Reflect.apply(target, receiver, args)];
	},
});
console.log(
	JSON.stringify(invoke(proxy.bind({ label: "proxy" }, { id: 14 }), [{ id: 15 }])),
);
const revoked = Proxy.revocable(strictTarget, {});
const boundRevoked = revoked.proxy.bind(null);
revoked.revoke();
try {
	invoke(boundRevoked, []);
} catch (error) {
	console.log("revoked", error instanceof TypeError);
}

class ConstructorOnly {}
try {
	invoke(ConstructorOnly.bind(null), []);
} catch (error) {
	console.log("class", error instanceof TypeError);
}
const marker = {};
function throwing() {
	throw marker;
}
try {
	invoke(throwing.bind(null), []);
} catch (error) {
	console.log("throw", error === marker);
}

function makeCaptured(offset) {
	const captured = { offset };
	return function capturedTarget(value) {
		return captured.offset + this.offset + value.offset;
	}.bind({ offset: 7 });
}
const callbacks = [makeCaptured(3), makeCaptured(11)];
let total = 0;
for (let index = 0; index < 200; index++) {
	total += invoke(callbacks[index & 1], [{ offset: index }]);
}
console.log("captured", total);
