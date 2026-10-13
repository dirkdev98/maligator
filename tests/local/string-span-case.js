"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_CASE_MODE;
const rows = [];
function observed(part) {
	collectGarbage();
	return `observed:${part}`;
}
function range(source, escape) {
	const part = source.slice(1, -1);
	const lower = part.toLowerCase(),
		upper = part.toUpperCase();
	collectGarbage();
	if (escape) return [lower, upper, observed(part), observed(part)];
	return [lower, upper];
}
function split(source, escape) {
	const part = source.split("|")[1];
	const lower = part.toLowerCase(),
		upper = part.toUpperCase();
	collectGarbage();
	if (escape) return [lower, upper, observed(part), observed(part)];
	return [lower, upper];
}
function capture(source, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const lower = part.toLowerCase(),
		upper = part.toUpperCase();
	collectGarbage();
	if (escape) return [lower, upper, observed(part), observed(part)];
	return [lower, upper];
}
function nested(source, escape) {
	const parent = source.slice(1, -1),
		part = parent.trim();
	const lower = part.toLowerCase(),
		upper = part.toUpperCase();
	collectGarbage();
	if (escape) return [lower, upper, observed(parent), observed(part)];
	return [lower, upper];
}
function lowerExtra(source, effect) {
	const part = source.slice(1, -1);
	return part.toLowerCase(Symbol("ignored"), effect(), 12n, null);
}
function upperExtra(source, effect) {
	const part = source.slice(1, -1);
	return part.toUpperCase(Symbol("ignored"), effect(), 12n, null);
}
if (["range", "split", "regexp", "nested"].includes(mode)) {
	const visit =
		mode === "range"
			? range
			: mode === "split"
				? split
				: mode === "regexp"
					? capture
					: nested;
	const source = (text) =>
		mode === "split" || mode === "regexp" ? "A|" + text + "|A" : "A" + text + "A";
	for (const text of [
		"",
		"unchanged",
		"UNCHANGED",
		"Café déjà",
		"µßÿ",
		"İıſ",
		"Σ",
		"ΑΣ",
		"ΟΣ\u0301",
		"ΟΣ\u0301Α",
		" \tΑΣ\ufeff ",
		"\ud800",
		"\udc00",
		"\ud801\udc00",
		"\ud801\udc28",
		"x😀Y",
	]) {
		rows.push(visit(source(text), false), visit(source(text), true));
	}
	const rope = "Ab".repeat(1300) + "ΟΣ\u0301" + "éß".repeat(1300);
	rows.push(visit(source(rope), false));
	if (mode === "range") {
		rows.push(range("\ud801\udc00X", true), range("X\ud801\udc00", true));
		rows.push(range("ĀCaféµßÿĀ", true), range("ĀunchangedĀ", true));
		const events = [];
		const ignored = () => {
			events.push("eval");
			collectGarbage();
			return {
				toString() {
					throw new Error("ignored coercion");
				},
			};
		};
		rows.push(lowerExtra("AΑΣA", ignored), upperExtra("AµßÿA", ignored), events);
	}
} else if (mode === "fallback") {
	const events = [];
	let token;
	const input = {
		slice() {
			events.push("slice");
			return (token = {
				toLowerCase(...args) {
					events.push(this === token, args.length);
					return "custom lower";
				},
				toUpperCase() {
					events.push(this === token);
					return "custom upper";
				},
				toString() {
					events.push("escape");
					return "token";
				},
			});
		},
	};
	rows.push(
		range(input, true),
		lowerExtra(input, () => {
			events.push("extra");
			return 1;
		}),
	);
	for (const invoke of [lowerExtra, upperExtra]) {
		const marker = { original: true };
		try {
			invoke("xAAy", () => {
				collectGarbage();
				throw marker;
			});
			throw new Error("missing");
		} catch (e) {
			if (e !== marker) throw e;
			events.push("original");
		}
	}
	if (process.env.SPAN_CASE_PRIMORDIALS !== "locked") {
		for (const [method, invoke] of [
			["toLowerCase", lowerExtra],
			["toUpperCase", upperExtra],
		]) {
			const saved = String.prototype[method];
			try {
				rows.push(
					invoke("xµßÿAy", () => {
						String.prototype[method] = function () {
							events.push("new");
							return "changed";
						};
						collectGarbage();
					}),
				);
				rows.push(invoke("xABAy", () => 0));
				String.prototype[method] = String.prototype.repeat;
				try {
					invoke("xABAy", () => 0);
					throw new Error("missing wrong-method error");
				} catch (e) {
					if (!(e instanceof TypeError)) throw e;
					events.push("wrong-method TypeError");
				}
			} finally {
				String.prototype[method] = saved;
			}
		}
	}
	rows.push(events);
}
console.log(JSON.stringify(rows));
