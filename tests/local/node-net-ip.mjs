import net, { isIP, isIPv4, isIPv6 } from "node:net";
const results = [];
const values = [
	"127.0.0.1",
	"0.0.0.0",
	"255.255.255.255",
	"01.2.3.4",
	"1.2.3",
	"256.1.1.1",
	"1.2.3.4\0junk",
	"1.2.3.4\n",
	"1.2.3.4/24",
	"::",
	"::1",
	"2001:db8::1",
	"::ffff:192.168.1.1",
	"::ffff:01.2.3.4",
	"[::1]",
	"fe80::1%lo0",
	"fe80::1%eth_0",
	"fe80::1%.:",
	"fe80::1%",
	"::1%x" + "y".repeat(80),
	"::1%é",
	"::1%x\0",
	"::1%x\n",
	"2001:db8:0:0:0:0:192.168.1.1",
	"2001:db8:0:0:0:0:0:1",
	"2001:db8:0:0:0:0:0:0:1",
	"2001:db8:::1",
	":::1",
	"12345::",
	"",
	undefined,
	null,
	3,
	new String("::1"),
	Symbol("x"),
];
for (const [name, fn] of [
	["isIP", isIP],
	["isIPv4", isIPv4],
	["isIPv6", isIPv6],
]) {
	results.push([name, "identity", net[name] === fn]);
	for (const value of values) {
		try {
			results.push([name, String(value), fn(value)]);
		} catch (error) {
			results.push([name, String(value), error.name]);
		}
	}
	for (const first of ["junk", "1.2.3.4"]) {
		const effects = [];
		const value = {
			[Symbol.toPrimitive](hint) {
				effects.push(hint);
				return effects.length === 1 ? first : "::1";
			},
		};
		results.push([name, "coercion", fn(value), effects]);
	}
	const effects = [];
	const target = new Proxy(function Target() {}, {
		get(object, key) {
			effects.push(String(key));
			return Reflect.get(object, key);
		},
	});
	const value = {
		toString() {
			effects.push("coerce");
			return "::1";
		},
	};
	const instance = Reflect.construct(fn, [value], target);
	const descriptor = Object.getOwnPropertyDescriptor(fn, "prototype");
	results.push([
		name,
		"metadata",
		fn.name,
		fn.length,
		Reflect.ownKeys(fn),
		descriptor.writable,
		descriptor.enumerable,
		descriptor.configurable,
		fn.prototype.constructor === fn,
		Object.getPrototypeOf(instance) === target.prototype,
		effects,
	]);
	const throwing = {
		[Symbol.toPrimitive]() {
			throw instance;
		},
	};
	try {
		Reflect.construct(fn, [throwing]);
	} catch (error) {
		results.push([name, "construct throw", error === instance]);
	}
}
console.log(JSON.stringify(results));
