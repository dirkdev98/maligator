import { runInNewContext } from "node:vm";

function copy(source) {
	return Object.assign({}, source);
}
function literal(value) {
	const target = {};
	return Object.assign(target, { first: value & 31 });
}
function owns(source, key) {
	return Object.hasOwn(source, key);
}

const foreign = runInNewContext("({ Object, source: { first: 7 } })");
const output = [copy(foreign.source), literal(11), owns(foreign.source, "first")];
const original = Object;
globalThis.Object = foreign.Object;
try {
	output.push(copy(foreign.source), literal(13), owns(foreign.source, "first"));
	foreign.Object.assign = (_target, source) => ({ replaced: source.first });
	foreign.Object.hasOwn = () => "replaced";
	output.push(copy(foreign.source), literal(17), owns(foreign.source, "first"));
} finally {
	globalThis.Object = original;
}
console.log(JSON.stringify(output));
