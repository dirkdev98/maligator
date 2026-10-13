const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
function inspectNested(node) {
	const kind = node.kind;
	if (typeof kind === "string") {
		const enabled = node.enabled;
		if (!enabled) {
			const left = node.left,
				right = node.right;
			return [left, right];
		}
		const value = node.value,
			label = node.label;
		return [value, label];
	}
	const first = node.first,
		last = node.last;
	return [first, last];
}
function readWide(node) {
	const v0 = node.p0;
	const v1 = node.p1;
	const v2 = node.p2;
	const v3 = node.p3;
	const v4 = node.p4;
	const v5 = node.p5;
	const v6 = node.p6;
	const v7 = node.p7;
	const v8 = node.p8;
	const v9 = node.p9;
	const v10 = node.p10;
	const v11 = node.p11;
	const v12 = node.p12;
	const v13 = node.p13;
	const v14 = node.p14;
	const v15 = node.p15;
	return [v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15];
}
globalThis.readNestedInput = inspectNested;
globalThis.readWideInput = readWide;
const rows = [];
const poisonous = {
	valueOf() {
		throw new Error("unexpected value coercion");
	},
	toString() {
		throw new Error("unexpected string coercion");
	},
};
const reference = { marker: "retained" };
for (const kind of [
	"tag",
	"",
	1,
	NaN,
	null,
	undefined,
	true,
	1n,
	Symbol("tag"),
	poisonous,
	() => 0,
]) {
	for (const enabled of [
		true,
		false,
		0,
		-0,
		NaN,
		"",
		"yes",
		undefined,
		null,
		0n,
		Symbol("yes"),
		poisonous,
	]) {
		const node = {
			kind,
			enabled,
			left: reference,
			right: "right",
			value: reference,
			label: "label",
			first: reference,
			last: "last",
		};
		let result;
		for (let warm = 0; warm < 4; warm++) result = globalThis.readNestedInput(node);
		collectGarbage?.();
		if (result[0] !== reference) throw new Error("field identity");
		const expected = typeof kind === "string" ? (!enabled ? "right" : "label") : "last";
		if (result[1] !== expected) throw new Error("typeof or truthiness");
		rows.push(expected);
	}
}
const wide = {
	p0: reference,
	p1: reference,
	p2: reference,
	p3: reference,
	p4: reference,
	p5: reference,
	p6: reference,
	p7: reference,
	p8: reference,
	p9: reference,
	p10: reference,
	p11: reference,
	p12: reference,
	p13: reference,
	p14: reference,
	p15: reference,
};
for (let warm = 0; warm < 8; warm++) {
	const result = globalThis.readWideInput(wide);
	collectGarbage?.();
	if (result.length !== 16 || !result.every((value) => value === reference))
		throw new Error("wide identity");
}
const events = [];
const mutable = {
	kind: "tag",
	enabled: false,
	left: reference,
	right: "old",
	value: reference,
	label: "label",
	first: reference,
	last: "last",
};
for (let warm = 0; warm < 8; warm++) globalThis.readNestedInput(mutable);
Object.defineProperty(mutable, "left", {
	configurable: true,
	get() {
		events.push("left");
		delete mutable.right;
		Object.setPrototypeOf(mutable, {
			get right() {
				events.push("right");
				collectGarbage?.();
				return "changed";
			},
		});
		collectGarbage?.();
		return reference;
	},
});
const changed = globalThis.readNestedInput(mutable);
if (
	changed[0] !== reference ||
	changed[1] !== "changed" ||
	events.join(",") !== "left,right"
)
	throw new Error("continuation replay");
const error = { abrupt: true };
Object.defineProperty(mutable, "enabled", {
	get() {
		collectGarbage?.();
		throw error;
	},
});
try {
	globalThis.readNestedInput(mutable);
	throw new Error("missing throw");
} catch (caught) {
	if (caught !== error) throw caught;
}
let proxyOrder = "";
const proxy = new Proxy(
	{ kind: "tag", enabled: true, value: reference, label: "proxy" },
	{
		get(target, key, receiver) {
			proxyOrder += key + ",";
			collectGarbage?.();
			return Reflect.get(target, key, receiver);
		},
	},
);
if (
	globalThis.readNestedInput(proxy)[1] !== "proxy" ||
	proxyOrder !== "kind,enabled,value,label,"
)
	throw new Error("proxy observations");
rows.push(events.join(","), proxyOrder);
console.log(JSON.stringify(rows));
