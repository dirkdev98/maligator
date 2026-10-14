const mode = process.env.PROPERTY_WIDE_MODE ?? "object";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function readWide(receiver) {
	const f0 = receiver.f0;
	const f1 = receiver.f1;
	const f2 = receiver.f2;
	const f3 = receiver.f3;
	const f4 = receiver.f4;
	const f5 = receiver.f5;
	const f6 = receiver.f6;
	const f7 = receiver.f7;
	const f8 = receiver.f8;
	const f9 = receiver.f9;
	const f10 = receiver.f10;
	const f11 = receiver.f11;
	const f12 = receiver.f12;
	const f13 = receiver.f13;
	const f14 = receiver.f14;
	const f15 = receiver.f15;
	const f16 = receiver.f16;
	const f17 = receiver.f17;
	const f18 = receiver.f18;
	const f19 = receiver.f19;
	const f20 = receiver.f20;
	const f21 = receiver.f21;
	const f22 = receiver.f22;
	const f23 = receiver.f23;
	const f24 = receiver.f24;
	const f25 = receiver.f25;
	const f26 = receiver.f26;
	const f27 = receiver.f27;
	const f28 = receiver.f28;
	const f29 = receiver.f29;
	const f30 = receiver.f30;
	const f31 = receiver.f31;
	const f32 = receiver.f32;
	const f33 = receiver.f33;
	const f34 = receiver.f34;
	const f35 = receiver.f35;
	const f36 = receiver.f36;
	const f37 = receiver.f37;
	const f38 = receiver.f38;
	const f39 = receiver.f39;
	return [
		f0,
		f1,
		f2,
		f3,
		f4,
		f5,
		f6,
		f7,
		f8,
		f9,
		f10,
		f11,
		f12,
		f13,
		f14,
		f15,
		f16,
		f17,
		f18,
		f19,
		f20,
		f21,
		f22,
		f23,
		f24,
		f25,
		f26,
		f27,
		f28,
		f29,
		f30,
		f31,
		f32,
		f33,
		f34,
		f35,
		f36,
		f37,
		f38,
		f39,
	];
}
globalThis.readWideFields = readWide;
function receiver(kind, extra = false) {
	let object;
	if (kind === "function") object = function callback() {};
	else if (kind === "bound") object = function callback() {}.bind(null);
	else if (kind === "native")
		new Promise((resolve) => {
			object = resolve;
		});
	else object = {};
	if (extra) object.prefix = "alternate layout";
	Object.assign(object, {
		f0: { index: 0, text: "field0" },
		f1: { index: 1, text: "field1" },
		f2: { index: 2, text: "field2" },
		f3: { index: 3, text: "field3" },
		f4: { index: 4, text: "field4" },
		f5: { index: 5, text: "field5" },
		f6: { index: 6, text: "field6" },
		f7: { index: 7, text: "field7" },
		f8: { index: 8, text: "field8" },
		f9: { index: 9, text: "field9" },
		f10: { index: 10, text: "field10" },
		f11: { index: 11, text: "field11" },
		f12: { index: 12, text: "field12" },
		f13: { index: 13, text: "field13" },
		f14: { index: 14, text: "field14" },
		f15: { index: 15, text: "field15" },
		f16: { index: 16, text: "field16" },
		f17: { index: 17, text: "field17" },
		f18: { index: 18, text: "field18" },
		f19: { index: 19, text: "field19" },
		f20: { index: 20, text: "field20" },
		f21: { index: 21, text: "field21" },
		f22: { index: 22, text: "field22" },
		f23: { index: 23, text: "field23" },
		f24: { index: 24, text: "field24" },
		f25: { index: 25, text: "field25" },
		f26: { index: 26, text: "field26" },
		f27: { index: 27, text: "field27" },
		f28: { index: 28, text: "field28" },
		f29: { index: 29, text: "field29" },
		f30: { index: 30, text: "field30" },
		f31: { index: 31, text: "field31" },
		f32: { index: 32, text: "field32" },
		f33: { index: 33, text: "field33" },
		f34: { index: 34, text: "field34" },
		f35: { index: 35, text: "field35" },
		f36: { index: 36, text: "field36" },
		f37: { index: 37, text: "field37" },
		f38: { index: 38, text: "field38" },
		f39: { index: 39, text: "field39" },
	});
	return object;
}
const rows = [];
function observe(result) {
	collectGarbage();
	return result.map((value) => value.text).join(",");
}
if (mode === "fallback") {
	for (const kind of ["object", "function", "bound", "native"]) {
		for (const position of [0, 20, 35]) {
			const object = receiver(kind);
			for (let i = 0; i < 3; i++) globalThis.readWideFields(object);
			const oldFirst = object.f0;
			const events = [];
			Object.defineProperty(object, `f${position}`, {
				get() {
					events.push(position);
					collectGarbage();
					if (position !== 0) object.f0 = { text: "changed first" };
					object.f39 = { text: "changed last" };
					return { text: "getter" };
				},
			});
			const result = globalThis.readWideFields(object);
			if (
				events.length !== 1 ||
				(position !== 0 && result[0] !== oldFirst) ||
				result[39] !== object.f39
			)
				throw new Error("replayed or stale property continuation");
			rows.push([kind, position, observe(result), events]);
		}
	}
	const object = receiver("function"),
		events = [];
	const proxy = new Proxy(object, {
		get(target, key) {
			events.push(key);
			collectGarbage();
			return target[key];
		},
	});
	rows.push(observe(globalThis.readWideFields(proxy)), events);
	let gets = 0;
	const sentinel = {};
	Object.defineProperty(object, "f35", {
		get() {
			gets++;
			collectGarbage();
			throw sentinel;
		},
	});
	try {
		globalThis.readWideFields(object);
		throw new Error("missing throw");
	} catch (error) {
		if (error !== sentinel) throw error;
	}
	if (gets !== 1) throw new Error("replayed exception");
	rows.push(gets);
} else if (mode === "polymorphic") {
	const objects = [receiver("object"), receiver("function", true), receiver("function")];
	for (let i = 0; i < 12; i++)
		rows.push(observe(globalThis.readWideFields(objects[i % 3])));
} else {
	const object =
		mode === "inherited"
			? Object.setPrototypeOf(function inherited() {}, receiver("object"))
			: receiver(mode);
	if (mode === "frozen") Object.freeze(object);
	const children = mode === "prototype" ? [Object.create(object)] : [];
	for (let i = 0; i < 5; i++) rows.push(observe(globalThis.readWideFields(object)));
	if (children.length && children[0].f0 !== object.f0)
		throw new Error("changed prototype");
}
console.log(JSON.stringify(rows));
