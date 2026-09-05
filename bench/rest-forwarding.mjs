function target(a = 0, b = 0, c = 0, d = 0) {
	return a + b * 3 + c * 5 + d * 7;
}
function alternate(a = 0, b = 0, c = 0, d = 0) {
	return a * 7 + b * 5 + c * 3 + d;
}
function spread(...args) {
	return target(...args);
}
function dynamic(fn, ...args) {
	return fn(...args);
}
function nested(...args) {
	return spread(...args);
}
function deep(...args) {
	return nested(...args);
}
function apply(...args) {
	return target.apply(this, args);
}
function prefix(first, ...rest) {
	return target(first, ...rest);
}
function fallback(...args) {
	args[0] += 1;
	return target(...args);
}
function overridden(a, b, c, d) {
	return target(a, b, c, d);
}
overridden.apply = function (receiver, args) {
	return target(args[0], args[1], args[2], args[3]);
};
function applyFallback(...args) {
	return overridden.apply(null, args);
}
const cases = [
	["control", (i) => target(i, 2, 3, 4)],
	["spread0", (i) => spread() + i],
	["spread1", (i) => spread(i)],
	["spread4", (i) => spread(i, 2, 3, 4)],
	["spread16", (i) => spread(i, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)],
	["dynamic", (i) => dynamic(i & 1 ? target : alternate, i, 2, 3, 4)],
	["nested3", (i) => deep(i, 2, 3, 4)],
	["apply", (i) => apply(i, 2, 3, 4)],
	["prefix", (i) => prefix(i, 2, 3, 4)],
	["fallback", (i) => fallback(i, 2, 3, 4)],
	["apply-fallback", (i) => applyFallback(i, 2, 3, 4)],
];
for (const [name, run] of cases) {
	let checksum = 0;
	for (let i = 0; i < 10000; i++) checksum += run(i & 1023);
	const start = Date.now();
	checksum = 0;
	for (let i = 0; i < 200000; i++) checksum += run(i & 1023);
	console.log(JSON.stringify({ name, ms: Date.now() - start, checksum }));
}
