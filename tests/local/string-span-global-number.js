"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_GLOBAL_NUMBER_MODE;
const rows = [];
function record(part) {
	collectGarbage();
	return `observed:${part}`;
}
function range(source, escape) {
	const part = source.slice(1, -1);
	const finite = isFinite(part),
		nan = isNaN(part);
	collectGarbage();
	if (escape) return [finite, nan, record(part), record(part)];
	return [finite, nan];
}
function split(source, escape) {
	const part = source.split("|")[1];
	const finite = isFinite(part),
		nan = isNaN(part);
	collectGarbage();
	if (escape) return [finite, nan, record(part), record(part)];
	return [finite, nan];
}
function capture(source, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const finite = isFinite(part),
		nan = isNaN(part);
	collectGarbage();
	if (escape) return [finite, nan, record(part), record(part)];
	return [finite, nan];
}
function nested(source, escape) {
	const parent = source.slice(1, -1);
	const part = parent.trim();
	const finite = isFinite(part),
		nan = isNaN(part);
	collectGarbage();
	return [
		finite,
		nan,
		record(parent, escape),
		record(part, escape),
		record(part, escape),
	];
}
function typedPredicates(source) {
	const part = source.slice(1, -1);
	return [part.length, Number.isFinite(part), Number.isNaN(part)];
}
function nanOnly(source) {
	const part = source.slice(1, -1);
	return isNaN(part);
}
function ignored(source, effect) {
	const part = source.slice(1, -1);
	return [part.length, isFinite(part, effect()), isNaN(part, effect())];
}
function named(source, namespace, effect) {
	const part = source.slice(1, -1);
	const finite = namespace.isFinite(part);
	effect();
	return [finite, namespace.isNaN(part), part.length];
}
if (mode === "range" || mode === "split" || mode === "regexp" || mode === "nested") {
	const visit =
		mode === "range"
			? range
			: mode === "split"
				? split
				: mode === "regexp"
					? capture
					: nested;
	for (const text of [
		"",
		" \t\ufeff ",
		"0",
		"-0",
		"12.5",
		"-3.2e+2",
		"0xff",
		"0b101",
		"0o71",
		"Infinity",
		"-Infinity",
		"NaN",
		"1tail",
		"１２",
		"\ud800",
		"😀",
		"1e309",
		"1e-4000",
	])
		for (const escape of [false, true])
			rows.push(
				visit(
					mode === "split" || mode === "regexp" ? "x|" + text + "|y" : "x" + text + "y",
					escape,
				),
			);
} else if (mode === "fallback") {
	const events = [];
	rows.push(typedPredicates("x12y"), typedPredicates("xNaNy"));
	for (const value of ["12", "NaN", "Infinity", 12, NaN, Infinity])
		rows.push([Number.isFinite(value), Number.isNaN(value)]);
	for (const value of [1n, Symbol("number")]) {
		const source = {
			slice() {
				events.push("slice");
				collectGarbage();
				return value;
			},
		};
		try {
			range(source, false);
			throw new Error("missing numeric error");
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			events.push("TypeError");
		}
		try {
			nanOnly(source);
			throw new Error("missing NaN error");
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			events.push("NaN TypeError");
		}
	}
	const object = {
		valueOf() {
			events.push("valueOf");
			collectGarbage();
			return "12";
		},
		toString() {
			throw new Error("unexpected string conversion");
		},
	};
	rows.push(
		range(
			{
				slice() {
					events.push("object");
					return object;
				},
			},
			false,
		),
	);
	let evaluations = 0;
	rows.push(
		ignored("x12y", () => {
			evaluations++;
			collectGarbage();
			return {
				valueOf() {
					throw new Error("extra argument coerced");
				},
			};
		}),
	);
	if (evaluations !== 2) throw new Error("ignored arguments replayed");
	const marker = { original: true };
	try {
		ignored("x12y", () => {
			throw marker;
		});
		throw new Error("missing argument throw");
	} catch (error) {
		if (error !== marker) throw error;
	}
	const namespace = {
		isFinite(value) {
			events.push(this === namespace, value);
			collectGarbage();
			return "finite";
		},
		isNaN: globalThis.isNaN,
	};
	rows.push(
		named("xNaNy", namespace, () => {
			namespace.isNaN = function (value) {
				events.push(this === namespace, value);
				return "nan";
			};
		}),
	);
	const captured = {
		get isFinite() {
			events.push("get");
			Object.defineProperty(captured, "isFinite", { value: () => false });
			return globalThis.isFinite;
		},
		isNaN: globalThis.isNaN,
	};
	rows.push(named("x12y", captured, collectGarbage));

	if (process.env.SPAN_GLOBAL_NUMBER_PRIMORDIALS === "mutable") {
		const savedFinite = globalThis.isFinite,
			savedNaN = globalThis.isNaN;
		try {
			rows.push(
				ignored("x12y", () => {
					globalThis.isFinite = () => 999;
					return Symbol("ignored");
				}),
			);
			globalThis.isFinite = function (value) {
				events.push("changed finite", value);
				return "changed";
			};
			globalThis.isNaN = function (value) {
				events.push("changed nan", value);
				return "changed";
			};
			rows.push(range("x12y", false));
		} finally {
			globalThis.isFinite = savedFinite;
			globalThis.isNaN = savedNaN;
		}
	}
	rows.push(events, evaluations);
} else throw new Error("unknown numeric span mode");
console.log(JSON.stringify([mode, rows]));
