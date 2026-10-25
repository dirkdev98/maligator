const events = [];
function collect() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function numberUnion(input, flag, extra) {
	return Array.isArray(flag ? +input : undefined, extra());
}
function stringUnion(input, flag, extra) {
	return Array.isArray(flag ? String(input) : null, extra());
}
function symbolUnion(input, flag, extra) {
	return Array.isArray(flag ? Symbol(input) : false, extra());
}
function bigintUnion(input, flag, extra) {
	return Array.isArray(flag ? BigInt(input) : undefined, extra());
}
function observe(input) {
	return Array.isArray(input);
}
function run(label, fn) {
	try {
		events.push(`${label}:${String(fn())}`);
	} catch (error) {
		events.push(`${label}:${error.name}`);
	}
}
const input = {
	[Symbol.toPrimitive](hint) {
		events.push(`coerce:${hint}`);
		collect();
		return "7";
	},
};
const throwing = {
	[Symbol.toPrimitive]() {
		events.push("coerce:throw");
		collect();
		throw new RangeError("conversion");
	},
};
for (const [name, fn] of [
	["number", numberUnion],
	["string", stringUnion],
	["symbol", symbolUnion],
	["bigint", bigintUnion],
]) {
	for (const flag of [false, true]) {
		for (const value of [
			input,
			throwing,
			undefined,
			null,
			true,
			-0,
			NaN,
			1n,
			Symbol("s"),
		]) {
			run(`${name}:${flag}`, () =>
				fn(value, flag, () => {
					events.push("extra");
					collect();
					return [];
				}),
			);
		}
		run(`${name}:extra-throw`, () =>
			fn(input, flag, () => {
				events.push("extra:throw");
				collect();
				throw new SyntaxError("extra");
			}),
		);
	}
}
for (const value of [[], {}, new Number(1), new Proxy([], {}), new Proxy({}, {})])
	run("unknown", () => observe(value));
const revoked = Proxy.revocable([], {});
revoked.revoke();
run("revoked", () => observe(revoked.proxy));
run("construct", () => new Array.isArray(+input));
run("spread", () =>
	Array.isArray(
		...{
			[Symbol.iterator]() {
				events.push("iterator");
				collect();
				return {
					next() {
						events.push("next:throw");
						throw new URIError("spread");
					},
				};
			},
		},
	),
);
if (Object.getOwnPropertyDescriptor(Array, "isArray").writable) {
	const original = Array.isArray;
	try {
		run("callee-before-extra", () =>
			numberUnion(input, true, () => {
				events.push("replace");
				Array.isArray = function (value) {
					collect();
					return `replacement:${typeof value}`;
				};
			}),
		);
		run("replacement", () =>
			stringUnion(input, false, () => {
				events.push("replacement-extra");
				collect();
			}),
		);
	} finally {
		Array.isArray = original;
	}
}
console.log(events.join("\n"));
