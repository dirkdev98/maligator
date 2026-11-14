import vm from "node:vm";

function normalized(input) {
	const visits = [];
	const result = [input].flat().some((value, index) => {
		visits.push(value, index);
		return value === "stop";
	});
	return [result, visits];
}
function withCallback(input, callback) {
	return [input].flat().some(callback);
}
const originalFlat = Object.getOwnPropertyDescriptor(Array.prototype, "flat");
const originalSome = Object.getOwnPropertyDescriptor(Array.prototype, "some");
function restore() {
	Object.defineProperty(Array.prototype, "flat", originalFlat);
	Object.defineProperty(Array.prototype, "some", originalSome);
}
const cases = {
	plain: () => {
		console.log(
			JSON.stringify([
				normalized("stop"),
				normalized(["first", "stop", "last"]),
				normalized([, "stop", ,]),
			]),
		);
	},
	"foreign-array": () => {
		console.log(
			JSON.stringify(normalized(vm.runInNewContext("['first', 'stop', 'last']"))),
		);
	},
	"foreign-callback": () => {
		const callback = vm.runInNewContext(
			"globalThis.marker = 'foreign'; (function(value, index, array) { if (globalThis.marker !== 'foreign' || value !== 'value' || index !== 0 || array.length !== 1) throw new Error('callback realm or arguments'); return true; })",
		);
		console.log(withCallback("value", callback));
	},
	"inner-species": () => {
		class Inner extends Array {
			static get [Symbol.species]() {
				throw new Error("inner species");
			}
		}
		console.log(JSON.stringify(normalized(new Inner("first", "stop"))));
	},
	proxy: () => {
		const trace = [];
		const proxy = new Proxy(["first", "stop"], {
			has(target, key) {
				trace.push("has:" + String(key));
				return Reflect.has(target, key);
			},
			get(target, key, receiver) {
				trace.push("get:" + String(key));
				return Reflect.get(target, key, receiver);
			},
		});
		console.log(JSON.stringify([normalized(proxy), trace]));
	},
	"patched-flat": () => {
		try {
			Array.prototype.flat = function () {
				return ["patched-flat"];
			};
			console.log(JSON.stringify(normalized("stop")));
		} finally {
			restore();
		}
	},
	"patched-some": () => {
		try {
			Array.prototype.some = function (callback) {
				return callback("patched-some", 7, this);
			};
			console.log(JSON.stringify(normalized("stop")));
		} finally {
			restore();
		}
	},
	"lookup-order": () => {
		try {
			const order = [];
			Object.defineProperty(Array.prototype, "flat", {
				configurable: true,
				get() {
					order.push("flat");
					return originalFlat.value;
				},
			});
			Object.defineProperty(Array.prototype, "some", {
				configurable: true,
				get() {
					order.push("some");
					return originalSome.value;
				},
			});
			console.log(JSON.stringify([normalized("stop"), order]));
		} finally {
			restore();
		}
	},
	"outer-species": () => {
		const species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
		try {
			Object.defineProperty(Array, Symbol.species, {
				configurable: true,
				value: class extends Array {
					some(callback) {
						return callback("species", 4, this);
					}
				},
			});
			console.log(JSON.stringify(normalized("stop")));
		} finally {
			Object.defineProperty(Array, Symbol.species, species);
		}
	},
	constructor: () => {
		const constructor = Object.getOwnPropertyDescriptor(Array.prototype, "constructor");
		try {
			Array.prototype.constructor = {
				[Symbol.species]: class extends Array {
					some(callback) {
						return callback("constructor-species", 3, this);
					}
				},
			};
			console.log(JSON.stringify(normalized("stop")));
		} finally {
			Object.defineProperty(Array.prototype, "constructor", constructor);
		}
	},
	accessor: () => {
		try {
			const accessor = ["first", "stop"];
			Object.defineProperty(accessor, 0, {
				get() {
					Array.prototype.some = function (callback) {
						return callback("during-flat", 5, this);
					};
					return "getter";
				},
			});
			console.log(JSON.stringify(normalized(accessor)));
		} finally {
			restore();
		}
	},
	"foreign-flat": () => {
		try {
			Array.prototype.flat = vm.runInNewContext("Array.prototype.flat");
			console.log(JSON.stringify(normalized(["first", "stop"])));
		} finally {
			restore();
		}
	},
	"inherited-index": () => {
		try {
			Object.defineProperty(Array.prototype, 1, {
				configurable: true,
				writable: true,
				value: "inherited",
			});
			console.log(JSON.stringify(normalized(["first", , "stop"])));
		} finally {
			delete Array.prototype[1];
		}
	},
	"prototype-chain": () => {
		const parent = Object.getPrototypeOf(Array.prototype);
		try {
			Object.setPrototypeOf(
				Array.prototype,
				Object.assign(Object.create(parent), { 1: "reparented" }),
			);
			console.log(JSON.stringify(normalized(["first", , "stop"])));
		} finally {
			Object.setPrototypeOf(Array.prototype, parent);
		}
	},
	revoked: () => {
		const revoked = Proxy.revocable([], {});
		revoked.revoke();
		try {
			normalized(revoked.proxy);
		} catch (error) {
			console.log(error.name);
		}
	},
};
const scenario = process.env.FLAT_GUARD_CASE || "plain";
if (scenario === "list") console.log(Object.keys(cases).join("\n"));
else {
	const run = cases[scenario];
	if (typeof run !== "function") throw new Error("unknown scenario");
	run();
}
