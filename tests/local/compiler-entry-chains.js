const log = [];
class Store {
	#retired = false;
	#values = [
		{ kind: "operation", start: 0 },
		{ kind: "return", start: 0 },
	];
	#require(index) {
		if (this.#retired) throw new Error("retired");
		if (this.#values[index] === undefined) throw new RangeError("instruction");
	}
	read(index) {
		this.#require(index);
		return this.#values[index].kind;
	}
	retire() {
		this.#retired = true;
	}
}
const store = new Store();
for (let i = 0; i < 8; i++) log.push(store.read(i % 2));
for (const receiver of [store, {}, new Proxy(store, {})]) {
	for (const index of [
		0,
		4,
		{
			valueOf() {
				log.push("coerce");
				globalThis.__mal_collect_garbage?.();
				return 0;
			},
		},
	]) {
		try {
			log.push(Store.prototype.read.call(receiver, index));
		} catch (error) {
			log.push(error.name);
		}
	}
}
const read = store.read;
store.read = () => "patched";
log.push(store.read(0), read.call(store, 0));
store.retire();
try {
	read.call(store, 0);
} catch (error) {
	log.push(error.message);
}

function predicates(values, receiver) {
	return values.filter(function predicate(value, index) {
		globalThis.__mal_collect_garbage?.();
		return value.kind === this.kind && index >= this.start;
	}, receiver);
}
const values = [{ kind: "operation", start: 0 }, , { kind: "return", start: 0 }];
Object.defineProperty(values, 1, {
	get() {
		log.push("get");
		return { kind: "operation", start: 0 };
	},
});
log.push(predicates(values, { kind: "operation", start: 0 }).length);
try {
	predicates([null], { kind: "operation", start: 0 });
} catch (error) {
	log.push(error.name);
}
const custom = [{ kind: "operation", start: 0 }];
custom.filter = (callback) => [
	callback.call({ kind: "operation", start: 0 }, custom[0], 0),
];
log.push(predicates(custom, { kind: "return", start: 0 })[0]);

function maybeVoid(value) {
	if (value === true) return;
	return [value];
}
globalThis.maybeVoid = maybeVoid;
for (const value of [true, 7, "fallback"])
	log.push(Reflect.apply(globalThis.maybeVoid, undefined, [value]));

function identityOrClone(value) {
	if (value && typeof value === "object" && !value.keep) return { ...value };
	return value;
}
globalThis.identityOrClone = identityOrClone;
const retained = { keep: true, id: 7 };
for (const value of [
	0,
	-0,
	NaN,
	Infinity,
	undefined,
	null,
	true,
	"identity",
	1n,
	Symbol("identity"),
	retained,
	retained,
])
	log.push(
		Object.is(Reflect.apply(globalThis.identityOrClone, undefined, [value]), value),
	);
log.push(Reflect.apply(globalThis.identityOrClone, undefined, []) === undefined);
const original = { keep: false, id: 11 };
const cloned = Reflect.apply(globalThis.identityOrClone, undefined, [original]);
log.push(cloned === original, cloned.keep, cloned.id);

function readReady() {
	"use strict";
	return this.ready;
}
globalThis.readReady = readReady;
for (const receiver of [
	{ ready: 7 },
	{
		get ready() {
			log.push("ready getter");
			globalThis.__mal_collect_garbage?.();
			return 11;
		},
	},
	{
		get ready() {
			log.push("ready throw");
			throw new Error("ready");
		},
	},
]) {
	try {
		log.push(Reflect.apply(globalThis.readReady, receiver, [log.push("extra argument")]));
	} catch (error) {
		log.push(error.message);
	}
}
console.log(JSON.stringify(log));
