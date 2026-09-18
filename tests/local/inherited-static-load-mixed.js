let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function original(value) {
	return value + 1;
}

function replacement(value) {
	return value + 2;
}

function loadMethod(receiver) {
	return receiver.method;
}

const holder = { method: original };
const ordinary = Object.create(holder);
const dictionary = Object.create(holder);
for (let index = 0; index < 48; index++) dictionary["field" + index] = index;

let proxyGets = 0;
const proxy = new Proxy(Object.create(holder), {
	get(target, key, receiver) {
		proxyGets++;
		return Reflect.get(target, key, receiver);
	},
});

for (let index = 0; index < 200; index++) {
	ok("ordinary warm", loadMethod(ordinary) === original);
}

for (let index = 0; index < 100; index++) {
	ok("ordinary mixed", loadMethod(ordinary) === original);
	ok("dictionary mixed", loadMethod(dictionary) === original);
	ok("primitive mixed", loadMethod(index) === undefined);
	ok("proxy mixed", loadMethod(proxy) === original);
}
ok("proxy trap preserved", proxyGets === 100);

holder.method = replacement;
ok("ordinary invalidated", loadMethod(ordinary) === replacement);
ok("dictionary invalidated", loadMethod(dictionary) === replacement);
ok("proxy invalidated", loadMethod(proxy) === replacement);
ok("proxy trap after invalidation", proxyGets === 101);

ok("checks ran", passed === 605);
console.log("inherited-static-load-mixed PASS");
