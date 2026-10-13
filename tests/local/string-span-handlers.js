"use strict";
const mode = process.env.SPAN_HANDLER_KIND || "split";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function afterSplit(source, shouldThrow, escape, observe, other) {
	try {
		observe("before", shouldThrow);
	} catch (error) {
		observe("caught", error);
	}
	const part = source.split("|")[1];
	const length = part.length;
	const equal = part === other;
	observe("middle");
	const found = part.indexOf("😀");
	if (escape) {
		observe("value", part);
		observe("value", part);
	}
	return [length, equal, found, part.length];
}
function afterRegexp(source, expression, shouldThrow, escape, observe) {
	try {
		observe("before", shouldThrow);
	} catch (error) {
		observe("caught", error);
	}
	const part = expression.exec(source)[1];
	const length = part.length;
	observe("middle");
	const found = part.indexOf("😀");
	if (escape) {
		observe("value", part);
		observe("value", part);
	}
	return [length, found, part.length];
}
function afterRange(source, shouldThrow, escape, observe, start) {
	try {
		observe("before", shouldThrow);
	} catch (error) {
		observe("caught", error);
	}
	const parent = source.slice(1, -1);
	const child = parent.substring(start, 5);
	const length = parent.length;
	observe("middle");
	const found = child.indexOf("😀");
	if (escape) {
		observe("value", parent);
		observe("value", child);
	}
	return [length, child.length, found, parent.length];
}
function disjoint(source, handler, observe) {
	if (handler) {
		try {
			observe("before", true);
		} catch (error) {
			return error.tag;
		}
		return "unreachable";
	}
	const part = source.split("|")[1];
	observe("middle");
	return [part.length, part.indexOf("😀")];
}
function catchRange(source, observe) {
	try {
		observe("before", true);
	} catch (error) {
		const parent = source.slice(1, -1);
		const child = parent.substring(0, 5);
		observe("middle");
		return [parent.length, child.length, child.indexOf("😀")];
	}
	return [];
}
function protectedAlias(source, observe) {
	const part = source.split("|")[1];
	try {
		observe("before", true);
	} catch (error) {
		observe("value", part);
		return [error.tag, part.length];
	}
	return part.length;
}
function generations(source, observe) {
	try {
		observe("before", true);
	} catch (error) {
		observe("caught", error);
	}
	let previous = "";
	const rows = [];
	for (let index = 0; index < source.length; index++) {
		const part = source[index].split("|")[1];
		observe("middle");
		rows.push(previous.length);
		previous = part;
	}
	return [rows, previous];
}
const events = [];
function observe(kind, value) {
	collectGarbage();
	if (kind === "before") {
		events.push(kind);
		if (value) throw { tag: "handled" };
	} else if (kind === "caught") events.push(value.tag);
	else if (kind === "value") events.push(`${kind}:${value}`);
}
const rows = [];
if (mode === "split" || mode === "regexp" || mode === "range" || mode === "catch") {
	for (const [index, token] of ["alpha", "😀a", "", "\ud83d", "a\u0000b"].entries()) {
		if (mode === "split")
			rows.push(
				afterSplit(`x|${token}|z`, index % 2 === 0, index % 2 === 1, observe, token),
			);
		else if (mode === "regexp")
			rows.push(
				afterRegexp(`x${token}z`, /^x(.*)z$/u, index % 2 === 0, index % 2 === 1, observe),
			);
		else if (mode === "range")
			rows.push(afterRange(`[${token}]`, index % 2 === 0, index % 2 === 1, observe, 0));
		else rows.push(catchRange(`[${token}]`, observe));
	}
} else if (mode === "disjoint") {
	rows.push(disjoint("x|😀a|z", false, observe), disjoint("x|unused|z", true, observe));
} else if (mode === "fallback") {
	let reads = 0,
		calls = 0;
	const part = {
		get length() {
			collectGarbage();
			return 9;
		},
		indexOf(needle) {
			collectGarbage();
			return needle.length;
		},
	};
	const source = {
		get split() {
			collectGarbage();
			reads++;
			return function (separator) {
				calls++;
				if (separator !== "|") throw new Error("separator");
				return [0, part];
			};
		},
	};
	rows.push(afterSplit(source, false, false, observe, part), reads, calls);
	const expression = /unused/;
	Object.defineProperty(expression, "exec", {
		value() {
			collectGarbage();
			return [0, "😀"];
		},
	});
	rows.push(afterRegexp("unused", expression, true, false, observe));
	const start = {
		valueOf() {
			events.push("coerce");
			collectGarbage();
			return 1;
		},
	};
	rows.push(afterRange("[x😀ab]", false, false, observe, start));
	for (const source of ["missing", "x|ok|z"]) {
		try {
			rows.push(
				afterSplit(
					source,
					true,
					false,
					source === "missing"
						? observe
						: () => {
								throw { tag: "escaping" };
							},
					"ok",
				),
			);
		} catch (error) {
			rows.push(error.tag ?? error.name);
		}
	}
	try {
		afterSplit(
			"x|live|z",
			false,
			false,
			(kind) => {
				collectGarbage();
				if (kind === "middle") throw { tag: "late" };
			},
			"live",
		);
	} catch (error) {
		rows.push(error.tag);
	}
} else if (mode === "protected") {
	rows.push(
		protectedAlias("x|😀abc|z", observe),
		generations(["x|a|z", "x|😀|z", "x|abc|z"], observe),
	);
} else throw new Error("unknown span handler mode");
console.log(JSON.stringify({ rows, events }));
