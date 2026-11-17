function makeSelf(payload) {
	var f = function () {
		return [f, payload];
	};
	return f;
}
function makeMapped(payload) {
	var f = function () {
		return [f, arguments.callee, payload, arguments[0], arguments.length];
	};
	return f;
}
function makeConstructor(payload) {
	var Constructor = function () {
		this.self = Constructor;
		this.payload = payload;
	};
	return Constructor;
}
function makeMutable() {
	let f = function mutableRead() {
		return f;
	};
	const original = f;
	return {
		original,
		set(value) {
			f = value;
		},
	};
}
function makeTdz() {
	const read = () => f;
	let before;
	try {
		read();
	} catch (error) {
		before = error.name;
	}
	const f = function tdzRead() {
		return f;
	};
	return [before, read, f];
}
const results = [];
const scenario = process.env.SELF_CAPTURE_CASE;
if (scenario === "constructors") {
	const Constructor = makeConstructor({ value: 17 });
	const Bound = Constructor.bind(null);
	const ProxyConstructor = new Proxy(Constructor, {});
	function Alternate() {}
	for (const instance of [
		new Constructor(),
		new Bound(),
		new ProxyConstructor(),
		Reflect.construct(Constructor, []),
		Reflect.construct(Bound, [], Alternate),
		Reflect.construct(ProxyConstructor, []),
	]) {
		results.push(instance.self === Constructor, instance.payload.value);
	}
	results.push(
		Object.getPrototypeOf(Reflect.construct(Constructor, [], Alternate)) ===
			Alternate.prototype,
	);
} else if (scenario === "identity") {
	const retained = [];
	for (let i = 0; i < 40; i++) retained.push(makeSelf({ value: i }));
	for (const f of retained) {
		const bound = f.bind({});
		const proxy = new Proxy(f, {});
		const a = f(),
			b = bound(),
			c = proxy();
		results.push(a[0] === f, b[0] === f, c[0] === f, a[1] === b[1], c[1].value);
	}
	results.push(retained[0] !== retained[1]);
} else if (scenario === "mutation") {
	const record = makeMutable();
	results.push(record.original() === record.original);
	const replacement = {};
	record.set(replacement);
	results.push(record.original() === replacement);
	let f = function readLater() {
		return f;
	};
	const original = f;
	f = replacement;
	results.push(original() === replacement);
} else if (scenario === "tdz") {
	const [before, read, f] = makeTdz();
	results.push(before, read() === f, f() === f);
} else if (scenario === "arguments") {
	const readers = [];
	for (let i = 0; i < 40; i++) readers.push(makeMapped({ value: i }));
	for (const f of readers) {
		const payload = {};
		const row = f(payload, 2);
		results.push(row[0] === f, row[1] === f, row[2].value, row[3] === payload, row[4]);
	}
} else throw new Error("unknown self capture case");
console.log(JSON.stringify(results));
