const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") throw new Error("proxy-revocation requires host GC");

function check(condition, name) {
	if (!condition) throw new Error(name);
}

function revokingPrototype(callable) {
	let revoke;
	const pair = Proxy.revocable(Object.create({ marker: 17 }), {
		marker: 19,
		get getPrototypeOf() {
			revoke();
			gc();
			return callable
				? function (target) {
						gc();
						check(this.marker === 19, "prototype trap handler");
						return Object.getPrototypeOf(target);
					}
				: undefined;
		},
	});
	revoke = pair.revoke;
	return pair.proxy;
}

function revokingCall(callable) {
	let revoke;
	const pair = Proxy.revocable(
		function (value) {
			gc();
			return { receiver: this, value };
		},
		{
			marker: 23,
			get apply() {
				revoke();
				gc();
				return callable
					? function (target, receiver, args) {
							gc();
							check(this.marker === 23, "apply trap handler");
							return Reflect.apply(target, receiver, args);
						}
					: undefined;
			},
		},
	);
	revoke = pair.revoke;
	return pair.proxy;
}

function revokingConstructor(callable) {
	let revoke;
	const pair = Proxy.revocable(
		function Target(value) {
			gc();
			this.value = value;
		},
		{
			marker: 29,
			get construct() {
				revoke();
				gc();
				return callable
					? function (target, args, newTarget) {
							gc();
							check(
								this.marker === 29 && target.name === "Target",
								"construct trap snapshot",
							);
							return Reflect.construct(target, args, newTarget);
						}
					: undefined;
			},
		},
	);
	revoke = pair.revoke;
	return pair.proxy;
}

for (const callable of [false, true]) {
	check(
		Object.getPrototypeOf(revokingPrototype(callable)).marker === 17,
		"prototype snapshot",
	);
	const called = Reflect.apply(revokingCall(callable), { marker: 31 }, [{ marker: 37 }]);
	check(called.receiver.marker === 31 && called.value.marker === 37, "call snapshot");
	const constructed = Reflect.construct(
		revokingConstructor(callable),
		[{ marker: 41 }],
		function Alternate() {},
	);
	check(constructed.value.marker === 41, "construct arguments and newTarget");
}

let rejected = false;
try {
	new (revokingConstructor(false))({ marker: 43 });
} catch (error) {
	rejected = error instanceof TypeError;
}
check(rejected, "revoked default newTarget remains observable");

const trace = [];
const inner = new Proxy(Object.preventExtensions(Object.create(null)), {
	isExtensible(target) {
		trace.push("extensible");
		gc();
		return Reflect.isExtensible(target);
	},
	getPrototypeOf(target) {
		trace.push("prototype");
		gc();
		return Reflect.getPrototypeOf(target);
	},
});
const outer = new Proxy(inner, {
	getPrototypeOf() {
		trace.push("trap");
		return null;
	},
});
check(
	Object.getPrototypeOf(outer) === null &&
		trace.join(",") === "trap,extensible,prototype",
	"nested prototype invariants",
);

console.log("proxy-revocation PASS");
