// Large functions whose rendered C the native splitter outlines into parts.

function* counter(limit) {
	for (let index = 0; index < limit; index++) yield index * 3;
}

class Base {
	constructor(label) {
		this.label = label;
	}
	describe() {
		return `base:${this.label}`;
	}
}

class Derived extends Base {
	constructor(label, extra) {
		if (extra < 0) throw new RangeError("negative extra");
		super(label);
		this.extra = extra;
	}
	describe() {
		return `${super.describe()}+${this.extra}`;
	}
}

function interpret(program, input, ...rest) {
	const stack = [];
	const trace = [];
	let accumulator = 0;
	let text = "";
	let scale = rest.length > 0 ? rest[0] : 1;
	const captured = { hits: 0 };
	const bump = (amount) => {
		captured.hits += amount;
		return captured.hits;
	};
	outer: for (let pc = 0; pc < program.length; pc++) {
		const op = program[pc];
		switch (op.kind) {
			case "push":
				stack.push(op.value * scale);
				break;
			case "add": {
				const right = stack.pop();
				const left = stack.pop();
				stack.push(left + right);
				break;
			}
			case "mul": {
				const right = stack.pop();
				const left = stack.pop();
				stack.push(left * right);
				break;
			}
			case "text": {
				let piece = "";
				for (const ch of op.value) piece = ch + piece;
				text += piece.toUpperCase();
				trace.push(`text:${piece.length}`);
				break;
			}
			case "loop": {
				let total = 0;
				for (let index = 0; index < op.count; index++) {
					total += index % 3 === 0 ? index : -1;
					if (total > 1000) break;
				}
				accumulator += total;
				trace.push(`loop:${total}`);
				break;
			}
			case "scale":
				scale = op.value;
				break;
			case "try": {
				try {
					if (op.fail) {
						const derived = new Derived("x", -1);
						trace.push(derived.describe());
					}
					accumulator += bump(op.amount);
				} catch (error) {
					trace.push(`caught:${error.name}:${error.message}`);
					accumulator -= 1;
				} finally {
					trace.push(`finally:${captured.hits}`);
				}
				break;
			}
			case "map": {
				const map = new Map();
				for (const [key, value] of Object.entries(op.value)) map.set(key, value * scale);
				let sum = 0;
				for (const [, value] of map) sum += value;
				accumulator += sum;
				trace.push(`map:${map.size}:${sum}`);
				break;
			}
			case "generate": {
				let sum = 0;
				for (const value of counter(op.count)) sum += value;
				accumulator += sum;
				trace.push(`gen:${sum}`);
				break;
			}
			case "class": {
				const derived = new Derived(op.label, op.extra);
				trace.push(derived.describe());
				break;
			}
			case "jump":
				if (accumulator > op.limit) {
					trace.push(`jump:${pc}`);
					continue outer;
				}
				pc += op.offset;
				break;
			case "spread": {
				const values = [...op.value, ...stack];
				const [first, second = 0, ...others] = values;
				accumulator += Math.max(...values) + first + second + others.length;
				trace.push(`spread:${values.length}`);
				break;
			}
			case "string": {
				const parts = op.value.split(",").map((part) => part.trim());
				const joined = parts.filter((part) => part.length > 1).join("|");
				text += joined;
				trace.push(`string:${parts.length}:${joined.charCodeAt(0)}`);
				break;
			}
			case "return":
				if (input === op.when) return { early: true, accumulator, text, trace };
				break;
			case "stop":
				break outer;
			default:
				throw new TypeError(`unknown op ${op.kind}`);
		}
	}
	return {
		early: false,
		accumulator,
		text,
		trace,
		stack,
		hits: captured.hits,
		scale,
		extra: rest.length,
	};
}

function classify(value) {
	let kind;
	if (typeof value === "number") {
		if (Number.isInteger(value)) kind = value % 2 === 0 ? "even" : "odd";
		else if (Number.isNaN(value)) kind = "nan";
		else kind = "fraction";
	} else if (typeof value === "string") {
		switch (value) {
			case "alpha":
			case "beta":
				kind = "greek";
				break;
			case "":
				kind = "empty";
				break;
			default:
				kind = value.length > 4 ? "long" : "short";
		}
	} else if (Array.isArray(value)) {
		kind = `array${value.length}`;
	} else if (value === null) {
		kind = "null";
	} else if (typeof value === "object") {
		kind = `object${Object.keys(value).join("")}`;
	} else {
		kind = typeof value;
	}
	return kind;
}

function survey(values) {
	const counts = {};
	let previous = "";
	let streak = 0;
	let longest = 0;
	for (const value of values) {
		const kind = classify(value);
		counts[kind] = (counts[kind] ?? 0) + 1;
		if (kind === previous) streak++;
		else {
			previous = kind;
			streak = 1;
		}
		if (streak > longest) longest = streak;
	}
	return { counts, longest };
}

const program = [
	{ kind: "push", value: 2 },
	{ kind: "push", value: 5 },
	{ kind: "add" },
	{ kind: "text", value: "split" },
	{ kind: "loop", count: 40 },
	{ kind: "try", amount: 3, fail: false },
	{ kind: "try", amount: 4, fail: true },
	{ kind: "map", value: { a: 1, b: 2, c: 3 } },
	{ kind: "scale", value: 2 },
	{ kind: "push", value: 7 },
	{ kind: "mul" },
	{ kind: "generate", count: 6 },
	{ kind: "class", label: "y", extra: 9 },
	{ kind: "spread", value: [4, 1, 8] },
	{ kind: "string", value: "a, bb , ccc,d , eeee" },
	{ kind: "jump", limit: 10_000, offset: 1 },
	{ kind: "push", value: 100 },
	{ kind: "return", when: "early" },
	{ kind: "loop", count: 2000 },
	{ kind: "stop" },
	{ kind: "push", value: 1 },
];

console.log(JSON.stringify(interpret(program, "late", 3, 4)));
console.log(JSON.stringify(interpret(program, "early")));
try {
	interpret([{ kind: "bogus" }], "late");
} catch (error) {
	console.log(`${error.name}: ${error.message}`);
}
console.log(
	JSON.stringify(
		survey([
			1,
			2,
			2.5,
			NaN,
			"alpha",
			"beta",
			"",
			"longer",
			"tiny",
			[1, 2],
			null,
			{ q: 1 },
			true,
		]),
	),
);

// A run of loads with no branch between them still divides at instruction boundaries.
let copy0,
	copy1,
	copy2,
	copy3,
	copy4,
	copy5,
	copy6,
	copy7,
	copy8,
	copy9,
	copy10,
	copy11,
	copy12,
	copy13,
	copy14,
	copy15,
	copy16,
	copy17,
	copy18,
	copy19;
function unpack(record) {
	copy0 = record.field0;
	copy1 = record.field1;
	copy2 = record.field2;
	copy3 = record.field3;
	copy4 = record.field4;
	copy5 = record.field5;
	copy6 = record.field6;
	copy7 = record.field7;
	copy8 = record.field8;
	copy9 = record.field9;
	copy10 = record.field10;
	copy11 = record.field11;
	copy12 = record.field12;
	copy13 = record.field13;
	copy14 = record.field14;
	copy15 = record.field15;
	copy16 = record.field16;
	copy17 = record.field17;
	copy18 = record.field18;
	copy19 = record.field19;
	const local20 = record.field20;
	const local21 = record.field21;
	const local22 = record.field22;
	const local23 = record.field23;
	const local24 = record.field24;
	const local25 = record.field25;
	const local26 = record.field26;
	const local27 = record.field27;
	const local28 = record.field28;
	const local29 = record.field29;
	const local30 = record.field30;
	const local31 = record.field31;
	const local32 = record.field32;
	const local33 = record.field33;
	const local34 = record.field34;
	const local35 = record.field35;
	const local36 = record.field36;
	const local37 = record.field37;
	const local38 = record.field38;
	const local39 = record.field39;
	return [
		copy0,
		copy1,
		copy2,
		copy3,
		copy4,
		copy5,
		copy6,
		copy7,
		copy8,
		copy9,
		copy10,
		copy11,
		copy12,
		copy13,
		copy14,
		copy15,
		copy16,
		copy17,
		copy18,
		copy19,
		local20,
		local21,
		local22,
		local23,
		local24,
		local25,
		local26,
		local27,
		local28,
		local29,
		local30,
		local31,
		local32,
		local33,
		local34,
		local35,
		local36,
		local37,
		local38,
		local39,
	].join(",");
}
const unpacked = {};
for (let index = 0; index < 40; index++) unpacked[`field${index}`] = index * 3;
console.log(unpack(unpacked));
unpacked.field7 = "seven";
console.log(unpack(unpacked));
