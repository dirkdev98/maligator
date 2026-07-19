let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function dictionaryPrototype(method) {
	const proto = {};
	Object.defineProperty(proto, "dictionaryMarker", { value: true, configurable: true });
	proto.method = method;
	return proto;
}

function warm(load, receiver, expected) {
	for (let i = 0; i < 5; i++) ok("warm", load(receiver) === expected);
}

{
	const proto = dictionaryPrototype("first");
	const receiver = Object.create(proto);
	const load = (value) => value.method;
	warm(load, receiver, "first");
	proto.method = "replacement";
	ok("prototype value replacement", load(receiver) === "replacement");
}

{
	const proto = dictionaryPrototype("data");
	const receiver = Object.create(proto);
	const load = (value) => value.method;
	warm(load, receiver, "data");
	let gets = 0;
	Object.defineProperty(proto, "method", {
		configurable: true,
		get() {
			gets++;
			return "accessor-" + gets;
		},
	});
	ok("accessor conversion first", load(receiver) === "accessor-1");
	ok("accessor conversion repeats getter", load(receiver) === "accessor-2");
}

{
	const proto = dictionaryPrototype("before-delete");
	const receiver = Object.create(proto);
	const load = (value) => value.method;
	warm(load, receiver, "before-delete");
	delete proto.method;
	ok("prototype delete", load(receiver) === undefined);
	proto.method = "after-add";
	ok("prototype re-add", load(receiver) === "after-add");
}

{
	const base = dictionaryPrototype("base");
	const middle = Object.create(base);
	const receiver = Object.create(middle);
	const load = (value) => value.method;
	warm(load, receiver, "base");
	middle.method = "middle";
	ok("intermediate shadow", load(receiver) === "middle");
	delete middle.method;
	ok("intermediate unshadow", load(receiver) === "base");
	receiver.method = "receiver";
	ok("receiver shadow", load(receiver) === "receiver");
	delete receiver.method;
	ok("receiver unshadow", load(receiver) === "base");
}

{
	const first = dictionaryPrototype("first-prototype");
	const second = dictionaryPrototype("second-prototype");
	const receiver = Object.create(first);
	const load = (value) => value.method;
	warm(load, receiver, "first-prototype");
	Object.setPrototypeOf(receiver, second);
	ok("receiver prototype replacement", load(receiver) === "second-prototype");
	Object.setPrototypeOf(second, dictionaryPrototype("parent"));
	delete second.method;
	ok("intermediate prototype replacement", load(receiver) === "parent");
}

{
	let traps = 0;
	const target = dictionaryPrototype("proxy");
	const proxy = new Proxy(target, {
		get(object, key, receiver) {
			traps++;
			return Reflect.get(object, key, receiver);
		},
	});
	const load = (value) => value.method;
	ok("proxy receiver first", load(proxy) === "proxy");
	ok("proxy receiver trap repeats", load(proxy) === "proxy" && traps === 2);

	traps = 0;
	const child = Object.create(proxy);
	ok("proxy prototype first", load(child) === "proxy");
	ok("proxy prototype trap repeats", load(child) === "proxy" && traps === 2);
}

{
	const gc = globalThis.__mal_collect_garbage;
	const proto = dictionaryPrototype(() => "old");
	const receiver = Object.create(proto);
	const load = (value) => value.method;
	warm(load, receiver, proto.method);
	for (let i = 0; i < 3; i++) {
		proto.method = () => i;
		if (typeof gc === "function") gc();
		ok("GC replacement remains live", load(receiver)() === i);
	}
}

{
	const source = `
		const proto = {};
		Object.defineProperty(proto, "dictionaryMarker", { value: true, configurable: true });
		proto.method = VALUE;
		const receiver = Object.create(proto);
		() => { let result; for (let i = 0; i < 20; i++) result = receiver.method; return result; }
	`;
	const one = new ShadowRealm().evaluate(source.replace("VALUE", "101"));
	const two = new ShadowRealm().evaluate(source.replace("VALUE", "202"));
	ok("realm one", one() === 101);
	ok("realm two", two() === 202);
	ok("realm separation", one() === 101);
}

ok("checks ran", passed > 40);
console.log("inherited-ordinary-cache PASS");
