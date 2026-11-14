import vm from "node:vm";

const originalFrom = Array.from;
const originalMap = Array.prototype.map;
let shared = 0;

function fromCallbacks() {
	const callbacks = Array.from(
		{ length: 3 },
		(_, bias) =>
			function mapped(value) {
				return value + bias + shared;
			},
	);
	let total = "";
	for (let index = 0; index < 6; index++) {
		shared = index;
		total += `${callbacks[index % 3](index)};`;
	}
	return total;
}

function mapCallbacks(source) {
	const callbacks = source.map(
		(bias) =>
			function mapped(value) {
				return `${value}:${bias}:${shared}:${this.marker}`;
			},
	);
	callbacks.marker = "result";
	let total = "";
	for (let index = 0; index < 6; index++) total += `${callbacks[index % 3](index)};`;
	return total;
}

const cases = {
	intact() {
		return [fromCallbacks(), mapCallbacks([1, 2, 3])];
	},
	"from-before"() {
		Array.from = () => [() => 11, () => 22, () => 33];
		return fromCallbacks();
	},
	"from-after"() {
		const first = fromCallbacks();
		Array.from = () => [() => 11, () => 22, () => 33];
		return [first, fromCallbacks()];
	},
	"from-mapper-arguments"() {
		Array.from = (_, mapper) => [mapper(null, "x"), mapper(null, 2n), mapper(null, {})];
		try {
			return fromCallbacks();
		} catch (error) {
			return error.name;
		}
	},
	"from-getter"() {
		let reads = 0;
		Object.defineProperty(Array, "from", {
			configurable: true,
			get() {
				reads++;
				return (_, mapper) => [mapper(0, "a"), mapper(0, "b"), mapper(0, "c")];
			},
		});
		return [fromCallbacks(), reads];
	},
	"from-proxies"() {
		const trace = [];
		Array.from = () =>
			new Proxy([0, 1, 2], {
				get(target, key) {
					trace.push(`get:${String(key)}`);
					return new Proxy(
						function (value) {
							return `${this.marker}:${value}`;
						},
						{
							apply(target, receiver, args) {
								trace.push(`apply:${String(key)}`);
								return Reflect.apply(target, { marker: "proxy" }, args);
							},
						},
					);
				},
			});
		return [fromCallbacks(), trace];
	},
	"from-foreign"() {
		const foreign = vm.runInNewContext(
			"[function(v){return this.length+v},function(v){return 2*v},function(v){return 3*v}]",
		);
		Array.from = () => foreign;
		return fromCallbacks();
	},
	"map-before"() {
		Array.prototype.map = () => [() => "a", () => "b", () => "c"];
		return mapCallbacks([1, 2, 3]);
	},
	"map-after"() {
		const first = mapCallbacks([1, 2, 3]);
		Array.prototype.map = () => [() => "a", () => "b", () => "c"];
		return [first, mapCallbacks([1, 2, 3])];
	},
	"map-species"() {
		const source = [1, 2, 3];
		source.constructor = {
			[Symbol.species]: function Result(length) {
				this.length = length;
			},
		};
		return mapCallbacks(source);
	},
	"map-foreign"() {
		return mapCallbacks(vm.runInNewContext("[1,2,3]"));
	},
	"map-proxy"() {
		const trace = [];
		const source = new Proxy([1, 2, 3], {
			get(target, key, receiver) {
				trace.push(`get:${String(key)}`);
				return Reflect.get(target, key, receiver);
			},
			has(target, key) {
				trace.push(`has:${String(key)}`);
				return Reflect.has(target, key);
			},
		});
		return [mapCallbacks(source), trace];
	},
	restored() {
		Array.from = () => [() => 11, () => 22, () => 33];
		const patched = fromCallbacks();
		Array.from = originalFrom;
		Array.prototype.map = originalMap;
		return [patched, fromCallbacks(), mapCallbacks([1, 2, 3])];
	},
};
const scenario = process.env.MAPPED_GUARD_CASE ?? "intact";
if (scenario === "list") console.log(Object.keys(cases).join("\n"));
else console.log(JSON.stringify(cases[scenario]()));
