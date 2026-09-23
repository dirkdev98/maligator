let total = 0;
function a(x) {
	return x + 1;
}
function b(x) {
	return x + 2;
}
function c(x) {
	return x + 3;
}
function d(x) {
	return x + 4;
}
function throwsAfterGuard() {
	throw 17;
}
function invoke(fn) {
	return fn(1);
}
const bound = a.bind(null);
const proxy = new Proxy(a, {
	apply(target, thisArg, args) {
		return Reflect.apply(target, thisArg, args);
	},
});
for (const fn of [a, b, throwsAfterGuard, c, d, a, Math.abs, bound, proxy]) {
	try {
		total += invoke(fn);
	} catch {}
}
let assigned = a;
function change() {
	assigned = b;
	return 2;
}
total += assigned(change());
function fails() {
	throw 19;
}
try {
	assigned(fails());
} catch {}
function nested() {
	total += invoke(b);
	return 1;
}
assigned = a;
total += assigned(nested());
console.log(total);
