const rows = [];
function observe(value) {
	if (typeof gc === "function") gc();
	return "observed:" + value;
}
function classify(source, escape) {
	const part = source.split("|")[1];
	const size = part.length;
	if (part === "if") return size + 10;
	if (escape) return observe(part);
	return size;
}
function compare(source, other) {
	const part = source.split("|")[1];
	return [part.length, part === other, part !== other];
}
function character(source) {
	const part = source.split("|")[1];
	return part.length + part.charCodeAt(0);
}
function retain(source) {
	const part = source.split("|")[1];
	if (part.length > 2) return part;
	return part === "if";
}
for (const source of [
	"a|if|tail",
	"a|else|tail",
	"a||",
	"|𝄞|",
	"x|\ud800y|z",
	"z|" + "x".repeat(300) + "|end",
	"prefix".repeat(100) + "|if|".repeat(100),
]) {
	rows.push(classify(source, false), classify(source, true), retain(source));
	for (const other of ["if", 2, null, undefined, Object("if")])
		rows.push(compare(source, other));
}
try {
	rows.push(classify("missing", false));
} catch (error) {
	rows.push(error.name);
}
let checksum = 0;
for (let i = 0; i < 400; i++) checksum += classify(i % 2 ? "a|if|z" : "a|else|z", false);
rows.push(checksum, ["a|if|z", "a|else|z"].map(classify));
if (typeof process !== "undefined" && process.env.MAL_SPAN_MUTABLE === "mutable") {
	const original = String.prototype.split;
	let calls = 0;
	String.prototype.split = function () {
		calls++;
		return {
			get 1() {
				calls += 10;
				return "if";
			},
		};
	};
	rows.push(classify("ignored", false), calls);
	String.prototype.split = original;
}
console.log(JSON.stringify(rows));
