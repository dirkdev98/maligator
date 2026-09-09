const results = [];
function record(label, action) {
	try {
		const value = action(),
			kind = typeof value;
		results.push(
			label +
				":" +
				kind +
				":" +
				(kind === "number"
					? Object.is(value, -0)
						? "-0"
						: String(value)
					: kind === "bigint"
						? String(value)
						: kind === "symbol"
							? value.toString()
							: JSON.stringify(value)),
		);
	} catch (error) {
		results.push(label + ":error:" + error.name);
	}
}

let effects = 0;
globalThis.sink = () => effects++;
globalThis.description = "dynamic";
const value0 = Symbol("payload");
function symbolCell0(x) {
	globalThis.sink(value0, x);
	return value0.toString(x);
}
globalThis.symbolCell0 = symbolCell0;
const value1 = Symbol("payload");
function symbolCell1(x) {
	globalThis.sink(value1, x);
	return value1.description;
}
globalThis.symbolCell1 = symbolCell1;
const value2 = Symbol("payload");
function symbolCell2(x) {
	globalThis.sink(value2, x);
	return value2.valueOf(x);
}
globalThis.symbolCell2 = symbolCell2;
const value3 = Symbol("payload");
function symbolCell3(x) {
	globalThis.sink(value3, x);
	return value3[Symbol.toPrimitive](x);
}
globalThis.symbolCell3 = symbolCell3;
const value4 = Symbol("payload");
function symbolCell4(x) {
	globalThis.sink(value4, x);
	return Symbol.keyFor(value4, x);
}
globalThis.symbolCell4 = symbolCell4;
const value5 = Symbol("payload");
function symbolCell5(x) {
	globalThis.sink(value5, x);
	return String(value5, x);
}
globalThis.symbolCell5 = symbolCell5;
const value6 = Symbol.for("payload");
function symbolCell6(x) {
	globalThis.sink(value6, x);
	return value6.toString(x);
}
globalThis.symbolCell6 = symbolCell6;
const value7 = Symbol.for("payload");
function symbolCell7(x) {
	globalThis.sink(value7, x);
	return value7.description;
}
globalThis.symbolCell7 = symbolCell7;
const value8 = Symbol.for("payload");
function symbolCell8(x) {
	globalThis.sink(value8, x);
	return value8.valueOf(x);
}
globalThis.symbolCell8 = symbolCell8;
const value9 = Symbol.for("payload");
function symbolCell9(x) {
	globalThis.sink(value9, x);
	return value9[Symbol.toPrimitive](x);
}
globalThis.symbolCell9 = symbolCell9;
const value10 = Symbol.for("payload");
function symbolCell10(x) {
	globalThis.sink(value10, x);
	return Symbol.keyFor(value10, x);
}
globalThis.symbolCell10 = symbolCell10;
const value11 = Symbol.for("payload");
function symbolCell11(x) {
	globalThis.sink(value11, x);
	return String(value11, x);
}
globalThis.symbolCell11 = symbolCell11;
const value12 = Symbol();
function symbolCell12(x) {
	globalThis.sink(value12, x);
	return value12.toString(x);
}
globalThis.symbolCell12 = symbolCell12;
const value13 = Symbol();
function symbolCell13(x) {
	globalThis.sink(value13, x);
	return value13.description;
}
globalThis.symbolCell13 = symbolCell13;
const value14 = Symbol();
function symbolCell14(x) {
	globalThis.sink(value14, x);
	return value14.valueOf(x);
}
globalThis.symbolCell14 = symbolCell14;
const value15 = Symbol();
function symbolCell15(x) {
	globalThis.sink(value15, x);
	return value15[Symbol.toPrimitive](x);
}
globalThis.symbolCell15 = symbolCell15;
const value16 = Symbol();
function symbolCell16(x) {
	globalThis.sink(value16, x);
	return Symbol.keyFor(value16, x);
}
globalThis.symbolCell16 = symbolCell16;
const value17 = Symbol();
function symbolCell17(x) {
	globalThis.sink(value17, x);
	return String(value17, x);
}
globalThis.symbolCell17 = symbolCell17;
const value18 = Symbol(globalThis.description);
function symbolCell18(x) {
	globalThis.sink(value18, x);
	return value18.toString(x);
}
globalThis.symbolCell18 = symbolCell18;
const value19 = Symbol(globalThis.description);
function symbolCell19(x) {
	globalThis.sink(value19, x);
	return value19.description;
}
globalThis.symbolCell19 = symbolCell19;
const value20 = Symbol(globalThis.description);
function symbolCell20(x) {
	globalThis.sink(value20, x);
	return value20.valueOf(x);
}
globalThis.symbolCell20 = symbolCell20;
const value21 = Symbol(globalThis.description);
function symbolCell21(x) {
	globalThis.sink(value21, x);
	return value21[Symbol.toPrimitive](x);
}
globalThis.symbolCell21 = symbolCell21;
const value22 = Symbol(globalThis.description);
function symbolCell22(x) {
	globalThis.sink(value22, x);
	return Symbol.keyFor(value22, x);
}
globalThis.symbolCell22 = symbolCell22;
const value23 = Symbol(globalThis.description);
function symbolCell23(x) {
	globalThis.sink(value23, x);
	return String(value23, x);
}
globalThis.symbolCell23 = symbolCell23;
const value24 = Symbol.for(globalThis.description);
function symbolCell24(x) {
	globalThis.sink(value24, x);
	return value24.toString(x);
}
globalThis.symbolCell24 = symbolCell24;
const value25 = Symbol.for(globalThis.description);
function symbolCell25(x) {
	globalThis.sink(value25, x);
	return value25.description;
}
globalThis.symbolCell25 = symbolCell25;
const value26 = Symbol.for(globalThis.description);
function symbolCell26(x) {
	globalThis.sink(value26, x);
	return value26.valueOf(x);
}
globalThis.symbolCell26 = symbolCell26;
const value27 = Symbol.for(globalThis.description);
function symbolCell27(x) {
	globalThis.sink(value27, x);
	return value27[Symbol.toPrimitive](x);
}
globalThis.symbolCell27 = symbolCell27;
const value28 = Symbol.for(globalThis.description);
function symbolCell28(x) {
	globalThis.sink(value28, x);
	return Symbol.keyFor(value28, x);
}
globalThis.symbolCell28 = symbolCell28;
const value29 = Symbol.for(globalThis.description);
function symbolCell29(x) {
	globalThis.sink(value29, x);
	return String(value29, x);
}
globalThis.symbolCell29 = symbolCell29;
record("fresh/Symbol.prototype.toString", () =>
	globalThis.symbolCell0({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("fresh/Symbol.prototype.description<get>", () =>
	globalThis.symbolCell1({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("fresh/Symbol.prototype.valueOf", () =>
	globalThis.symbolCell2({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("fresh/Symbol.prototype[%Symbol.toPrimitive%]", () =>
	globalThis.symbolCell3({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("fresh/Symbol.keyFor", () =>
	globalThis.symbolCell4({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("fresh/String", () =>
	globalThis.symbolCell5({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("registered/Symbol.prototype.toString", () =>
	globalThis.symbolCell6({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("registered/Symbol.prototype.description<get>", () =>
	globalThis.symbolCell7({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("registered/Symbol.prototype.valueOf", () =>
	globalThis.symbolCell8({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("registered/Symbol.prototype[%Symbol.toPrimitive%]", () =>
	globalThis.symbolCell9({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("registered/Symbol.keyFor", () =>
	globalThis.symbolCell10({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("registered/String", () =>
	globalThis.symbolCell11({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("absent/Symbol.prototype.toString", () =>
	globalThis.symbolCell12({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("absent/Symbol.prototype.description<get>", () =>
	globalThis.symbolCell13({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("absent/Symbol.prototype.valueOf", () =>
	globalThis.symbolCell14({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("absent/Symbol.prototype[%Symbol.toPrimitive%]", () =>
	globalThis.symbolCell15({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("absent/Symbol.keyFor", () =>
	globalThis.symbolCell16({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("absent/String", () =>
	globalThis.symbolCell17({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-fresh/Symbol.prototype.toString", () =>
	globalThis.symbolCell18({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-fresh/Symbol.prototype.description<get>", () =>
	globalThis.symbolCell19({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-fresh/Symbol.prototype.valueOf", () =>
	globalThis.symbolCell20({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-fresh/Symbol.prototype[%Symbol.toPrimitive%]", () =>
	globalThis.symbolCell21({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-fresh/Symbol.keyFor", () =>
	globalThis.symbolCell22({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-fresh/String", () =>
	globalThis.symbolCell23({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-registry/Symbol.prototype.toString", () =>
	globalThis.symbolCell24({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-registry/Symbol.prototype.description<get>", () =>
	globalThis.symbolCell25({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-registry/Symbol.prototype.valueOf", () =>
	globalThis.symbolCell26({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-registry/Symbol.prototype[%Symbol.toPrimitive%]", () =>
	globalThis.symbolCell27({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-registry/Symbol.keyFor", () =>
	globalThis.symbolCell28({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("unknown-registry/String", () =>
	globalThis.symbolCell29({
		toString() {
			throw new Error("ignored");
		},
	}),
);
record("effects", () => effects);
if (results.some((value) => value.includes(":error:")))
	throw new Error(results.filter((value) => value.includes(":error:")).join("\n"));
function before() {
	return initialized.toString();
}
globalThis.before = before;
record("symbol-before-initialization", () => globalThis.before());
const initialized = Symbol("initialized");
record("symbol-after-initialization", () => globalThis.before());
function escapeEarly() {
	globalThis.uninitialized = () => late.description;
	return;
	const late = Symbol("late");
}
escapeEarly();
record("symbol-capture-before-initialization", () => globalThis.uninitialized());
function make() {
	const symbol = Symbol("same");
	globalThis.sink(symbol);
	return () => symbol.valueOf();
}
const left = make(),
	right = make();
record("activation-identities", () => [
	left() === left(),
	left() === right(),
	new Map([
		[left(), 1],
		[right(), 2],
	]).size,
]);
function recursive(depth) {
	const symbol = Symbol("recursion");
	globalThis.sink(symbol);
	if (depth === 0) return [symbol];
	const result = recursive(depth - 1);
	result.push(symbol);
	return result;
}
record("recursive-identities", () => new Set(recursive(4)).size);
const registered = Symbol.for("shared"),
	same = Symbol.for("shared"),
	different = Symbol.for("other"),
	wellKnown = Symbol.iterator,
	matchingDescription = Symbol.for("Symbol.iterator");
function compare() {
	globalThis.sink(registered, same, different, wellKnown, matchingDescription);
	return [
		registered === same,
		registered === different,
		wellKnown === matchingDescription,
	];
}
record("stable-identities", compare);
function joined(choice, key) {
	const value = choice ? Symbol(key) : Symbol.for(key);
	globalThis.sink(value);
	return Symbol.keyFor(value);
}
record("joined-fresh", () => joined(true, "joined"));
record("joined-registry", () => joined(false, "joined"));
let order = "";
function createWithEffect(factory, value) {
	return factory({
		toString() {
			order += "k";
			return value;
		},
	});
}
record("fresh-coercion", () => {
	const symbol = createWithEffect(Symbol, "effect");
	globalThis.sink(symbol);
	return [Symbol.keyFor(symbol), symbol.description];
});
record("fresh-coercion-order", () => order);
order = "";
record("registry-coercion", () => {
	const symbol = createWithEffect(Symbol.for, "effect");
	globalThis.sink(symbol);
	return [Symbol.keyFor(symbol), symbol === Symbol.for("effect")];
});
record("registry-coercion-order", () => order);
order = "";
record("coercion-failure", () =>
	Symbol.for({
		toString() {
			order += "k";
			throw new URIError("failed");
		},
	}),
);
record("coercion-failure-order", () => order);
record("symbol-key-coercion", () => Symbol.for(Symbol("x")));
record("fresh-key-coercion", () => Symbol(Symbol("x")));
record("description-distinction", () => [
	Symbol().description,
	Symbol(undefined).description,
	Symbol("undefined").description,
]);
record("implicit-symbol-string", () => "" + initialized);
record("implicit-symbol-number", () => Math.abs(initialized));
record("wrapper-key", () => Symbol.keyFor(Object(initialized)));
record("wrapper-value", () => Object(initialized).valueOf() === initialized);
let changing = Symbol("before");
function changed() {
	return changing.toString();
}
record("mutable-binding-before", changed);
changing = {
	toString() {
		return "after";
	},
};
record("mutable-binding-after", changed);
if (!Object.isFrozen(Symbol.prototype)) {
	const original = Symbol.prototype.toString;
	try {
		Symbol.prototype.toString = function () {
			return "custom";
		};
		record("mutable-prototype", () => initialized.toString());
	} finally {
		Symbol.prototype.toString = original;
	}
} else results.push('mutable-prototype:string:"custom"');
if (!Object.isFrozen(Symbol)) {
	const original = Symbol;
	try {
		globalThis.Symbol = function () {
			return {
				description: "custom",
				toString() {
					return "factory";
				},
			};
		};
		record("mutable-factory", () => Symbol("x").toString());
	} finally {
		globalThis.Symbol = original;
	}
} else results.push('mutable-factory:string:"factory"');
console.log(results.join("\n"));
