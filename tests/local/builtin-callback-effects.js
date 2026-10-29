function check(actual, expected) {
	if (!Object.is(actual, expected)) throw new Error("builtin callback effect mismatch");
}
function typeError(action) {
	try {
		action();
	} catch (error) {
		check(error instanceof TypeError, true);
		return;
	}
	throw new Error("missing callback validation error");
}
const collect = globalThis.__mal_collect_garbage;
const map = new Map([[1, 11]]);
const set = new Set([11]);
const observe = function observe(value) {
	for (let i = 0; i < 3; i++) {}
	return typeof value;
};
function callbackUntouched(payload) {
	const record = { x: payload };
	const before = record.x;
	Map.prototype.forEach.call(map, observe, record);
	return [before, record.x];
}
function builtinCallbackUntouched(payload) {
	const record = { x: payload };
	const before = record.x;
	Set.prototype.forEach.call(set, Number.isFinite, record);
	return [before, record.x];
}
function* suspendedCallback(payload) {
	const record = { x: payload };
	yield record.x;
	Map.prototype.forEach.call(map, observe, record);
	return record.x;
}
for (const payload of [11, NaN, "payload", { alive: true }]) {
	for (const read of [callbackUntouched, builtinCallbackUntouched]) {
		const result = read(payload);
		check(result[0], payload);
		check(result[1], payload);
	}
	const iterator = suspendedCallback(payload);
	check(iterator.next().value, payload);
	if (typeof collect === "function") collect();
	check(iterator.next().value, payload);
}

const record = { x: 11 };
Map.prototype.forEach.call(
	map,
	function change(value, key, collection) {
		check(value, 11);
		check(key, 1);
		check(collection, map);
		this.x = 99;
		if (typeof collect === "function") collect();
	},
	record,
);
check(record.x, 99);
let captured = 0;
Set.prototype.forEach.call(set, function change(value, key, collection) {
	check(value, key);
	check(collection, set);
	captured++;
});
check(captured, 1);

const growing = new Map([[1, 11]]);
let visits = 0;
growing.forEach(function grow(value, key, collection) {
	visits++;
	if (key === 1) collection.set(2, 22);
});
check(visits, 2);
const marker = {};
try {
	map.forEach(function fail() {
		throw marker;
	});
	throw new Error("missing callback exception");
} catch (error) {
	check(error, marker);
}
typeError(() => Map.prototype.forEach.call(map, 17));
typeError(() => Map.prototype.forEach.call(map));
typeError(() => Set.prototype.forEach.call(set, class Callback {}));
typeError(() => Map.prototype.forEach.call(new Proxy(map, {}), observe));

let traps = 0;
map.forEach(
	new Proxy(observe, {
		apply(target, receiver, args) {
			traps++;
			check(receiver, record);
			return Reflect.apply(target, receiver, args);
		},
	}),
	record,
);
check(traps, 1);
const revoked = Proxy.revocable(observe, {});
revoked.revoke();
typeError(() => map.forEach(revoked.proxy));
let conversions = 0;
const coercing = new Set([
	{
		valueOf() {
			conversions++;
			record.x = 123;
			return 1;
		},
	},
]);
coercing.forEach(Math.abs, record);
check(record.x, 123);
check(conversions, 1);

let lookups = 0;
const shadowed = {
	get forEach() {
		lookups++;
		return function replaced(callback, receiver) {
			receiver.x = 456;
			callback(receiver.x);
		};
	},
};
function methodCallback(collection, payload) {
	const state = { x: payload };
	collection.forEach(observe, state);
	return state.x;
}
check(methodCallback(shadowed, 11), 456);
check(lookups, 1);
let order = "";
try {
	Map.prototype.forEach.call(
		{},
		observe,
		(order += "argument"),
		(() => {
			throw marker;
		})(),
	);
	throw new Error("missing argument exception");
} catch (error) {
	check(error, marker);
}
check(order, "argument");

let generatorCalls = 0;
map.forEach(function* deferred() {
	generatorCalls++;
	yield 1;
});
check(generatorCalls, 0);
let asyncCalls = 0;
map.forEach(async function immediate() {
	asyncCalls++;
});
check(asyncCalls, 1);

if (Object.getOwnPropertyDescriptor(Map.prototype, "forEach").writable) {
	const original = Map.prototype.forEach;
	try {
		Map.prototype.forEach = function replaced(callback, receiver) {
			receiver.x = 789;
			callback(receiver.x);
		};
		const result = callbackUntouched(11);
		check(result[0], 11);
		check(result[1], 789);
	} finally {
		Map.prototype.forEach = original;
	}
}
Object.assign(globalThis, {
	callbackUntouched,
	builtinCallbackUntouched,
	suspendedCallback,
	methodCallback,
});
console.log("builtin-callback-effects PASS");
