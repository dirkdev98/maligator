const mode = process.env.SPAN_EQUAL_KIND || "values";
const gc = globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
function compare(source, start, end, other, escape, observe) {
	const part = source.slice(start, end);
	const first = part === other;
	observe();
	if (escape) return part;
	return [first, other !== part, part.length];
}
function compareTwo(source, other) {
	const left = source.slice(1, -1),
		right = other.substring(1, other.length - 1);
	return [left === right, right !== left, left.length, right.length];
}
function aliases(source, escape) {
	const part = source.slice(1, -1);
	let other = part;
	if (escape) other = "different";
	return [part === other, other !== part, part.length];
}
const rows = [];
const collect = () => gc?.();
if (mode === "values") {
	let coerced = 0;
	const poison = {
		toString() {
			coerced++;
			throw new Error("coerced");
		},
		valueOf() {
			coerced++;
			throw new Error("coerced");
		},
		[Symbol.toPrimitive]() {
			coerced++;
			throw new Error("coerced");
		},
	};
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	const inputs = [
		"alpha",
		["al", "pha"].join(""),
		"alpHa",
		"alph",
		"alphab",
		new String("alpha"),
		poison,
		revoked.proxy,
		undefined,
		null,
		true,
		false,
		0,
		NaN,
		1n,
		Symbol("alpha"),
	];
	for (const other of inputs) rows.push(compare("[alpha]", 1, -1, other, false, collect));
	for (const value of ["", "\ud83d", "\ude00", "😀", "a\u0000b", "é", "e\u0301"]) {
		rows.push(compare(`[${value}]`, 1, -1, value, true, collect));
		rows.push(compareTwo(`[${value}]`, `(${value})`));
	}
	let rope = "";
	for (let i = 0; i < 160; i++) rope += "ab😀";
	const other = [rope.slice(0, 100), rope.slice(100)].join("");
	rows.push(compare(`[${rope}]`, 1, -1, other, false, collect));
	rows.push(
		compareTwo("[alpha]", "[alpHa]"),
		aliases("[same]", false),
		aliases("[same]", true),
		coerced,
	);
} else if (mode === "fallback") {
	const events = [];
	const source = {
		slice(start, end) {
			events.push(`slice:${start}:${end}`);
			return {
				get length() {
					events.push("length");
					return 7;
				},
			};
		},
	};
	rows.push(
		compare(source, 1, 3, "abc", false, () => events.push("observe")),
		events,
	);
	const bounds = [];
	rows.push(
		compare(
			"[alpha]",
			{
				valueOf() {
					bounds.push("start");
					return 1;
				},
			},
			{
				valueOf() {
					bounds.push("end");
					return -1;
				},
			},
			"alpha",
			true,
			collect,
		),
		bounds,
	);
	let once = 0;
	rows.push(
		compare("[alpha]", 1, -1, "alpha", true, () => {
			once++;
			gc?.();
		}),
		once,
	);
} else throw new Error("unknown mode");
console.log(JSON.stringify(rows));
