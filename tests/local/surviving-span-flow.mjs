const rows = [];
let observed = 0;
function collect() {
	if (typeof globalThis.__mal_collect_garbage === "function")
		globalThis.__mal_collect_garbage();
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function observe(value) {
	observed++;
	collect();
	return "seen:" + value;
}
function stableObserver(source, escape, sink) {
	const part = source.split("|")[1];
	if (escape !== escape) sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
function stableOverwrite(source, escape, sink) {
	let part = source.split("|")[1];
	if (escape !== escape) part = sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
function capturedObserver(source, escape, sink) {
	const part = /x(.*)z/.exec(source)[1];
	if (escape !== escape) sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
function capturedOverwrite(source, escape, sink) {
	let part = /x(.*)z/.exec(source)[1];
	if (escape !== escape) part = sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
for (const text of ["if", "other", "", "𝄞", "\ud800x", "x".repeat(400)]) {
	const split = "prefix|" + text + "|tail";
	const capture = "x" + text + "z";
	rows.push(
		stableObserver(split, "string", observe),
		stableOverwrite(split, "string", observe),
		capturedObserver(capture, "string", observe),
		capturedOverwrite(capture, "string", observe),
	);
	for (const escape of [NaN, false, 1, null, undefined, {}, Symbol("s")])
		rows.push(
			stableObserver(split, escape, observe),
			stableOverwrite(split, escape, observe),
			capturedObserver(capture, escape, observe),
			capturedOverwrite(capture, escape, observe),
		);
}
for (const value of ["if", "other", 12, false, { length: 7 }, undefined]) {
	const source = {
		split(separator) {
			collect();
			rows.push(separator);
			return ["prefix", value];
		},
	};
	try {
		rows.push(stableObserver(source, "string", observe));
		rows.push(stableOverwrite(source, "string", observe));
		rows.push(stableOverwrite(source, NaN, observe));
	} catch (error) {
		rows.push(error.name);
	}
}
const source = {
	split() {
		return [
			0,
			Object.defineProperty({}, "length", {
				get() {
					collect();
					rows.push("length");
					return 11;
				},
			}),
		];
	},
};
rows.push(stableObserver(source, "string", observe));
try {
	stableOverwrite("p|if|t", NaN, () => {
		collect();
		throw new Error("observer");
	});
} catch (error) {
	rows.push(error.message);
}
try {
	capturedObserver("no-match", "string", observe);
} catch (error) {
	rows.push(error.name);
}
console.log(JSON.stringify([rows, observed]));
