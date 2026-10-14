const mode = process.env.RECORD_READ_MODE ?? "sum";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function sum(record) {
	return record.x + record.y + record.z + record.w + record.v;
}
function branch(record) {
	let value;
	if (record.x < record.y) value = Math.hypot(record.x, record.y, record.z, record.w);
	else value = Math.max(record.x, record.y, record.z, record.w);
	return value;
}
function wide(record) {
	return (
		record.f0 +
		record.f1 +
		record.f2 +
		record.f3 +
		record.f4 +
		record.f5 +
		record.f6 +
		record.f7 +
		record.f8 +
		record.f9 +
		record.f10 +
		record.f11 +
		record.f12 +
		record.f13 +
		record.f14 +
		record.f15 +
		record.f16 +
		record.f17 +
		record.f18 +
		record.f19 +
		record.f20 +
		record.f21 +
		record.f22 +
		record.f23 +
		record.f24 +
		record.f25 +
		record.f26 +
		record.f27 +
		record.f28 +
		record.f29 +
		record.f30 +
		record.f31 +
		record.f32 +
		record.f33 +
		record.f34 +
		record.f35 +
		record.f36 +
		record.f37 +
		record.f38 +
		record.f39
	);
}
function update(record, scale) {
	record.f0 = (record.f0 + scale) * scale - scale;
	record.f1 = (record.f1 + scale) * scale - scale;
	record.f2 = (record.f2 + scale) * scale - scale;
	record.f3 = (record.f3 + scale) * scale - scale;
	record.f4 = (record.f4 + scale) * scale - scale;
	record.f5 = (record.f5 + scale) * scale - scale;
	record.f6 = (record.f6 + scale) * scale - scale;
	record.f7 = (record.f7 + scale) * scale - scale;
	record.f8 = (record.f8 + scale) * scale - scale;
	record.f9 = (record.f9 + scale) * scale - scale;
	record.f10 = (record.f10 + scale) * scale - scale;
	record.f11 = (record.f11 + scale) * scale - scale;
	record.f12 = (record.f12 + scale) * scale - scale;
	record.f13 = (record.f13 + scale) * scale - scale;
	record.f14 = (record.f14 + scale) * scale - scale;
	record.f15 = (record.f15 + scale) * scale - scale;
	record.f16 = (record.f16 + scale) * scale - scale;
	record.f17 = (record.f17 + scale) * scale - scale;
	record.f18 = (record.f18 + scale) * scale - scale;
	record.f19 = (record.f19 + scale) * scale - scale;
	record.f20 = (record.f20 + scale) * scale - scale;
	record.f21 = (record.f21 + scale) * scale - scale;
	record.f22 = (record.f22 + scale) * scale - scale;
	record.f23 = (record.f23 + scale) * scale - scale;

	return record.f0 + record.f1 + record.f2 + record.f3;
}
globalThis.readRecordSum = sum;
globalThis.readRecordBranch = branch;
globalThis.readRecordWide = wide;
globalThis.updateWideRecord = update;
const rows = [];
function scalar(value) {
	if (Object.is(value, -0)) return "-0";
	if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
	return mode === "branch" ? value.toPrecision(12) : value;
}
function fields() {
	return {
		f0: -19,
		f1: -18,
		f2: -17,
		f3: -16,
		f4: -15,
		f5: -14,
		f6: -13,
		f7: -12,
		f8: -11,
		f9: -10,
		f10: -9,
		f11: -8,
		f12: -7,
		f13: -6,
		f14: -5,
		f15: -4,
		f16: -3,
		f17: -2,
		f18: -1,
		f19: 0,
		f20: 1,
		f21: 2,
		f22: 3,
		f23: 4,
		f24: 5,
		f25: 6,
		f26: 7,
		f27: 8,
		f28: 9,
		f29: 10,
		f30: 11,
		f31: 12,
		f32: 13,
		f33: 14,
		f34: 15,
		f35: 16,
		f36: 17,
		f37: 18,
		f38: 19,
		f39: 20,
	};
}

if (mode === "fallback") {
	const events = [];
	const target = { x: 1, y: 2, z: 3, w: 4, v: 5 };
	const proxy = new Proxy(target, {
		get(object, key) {
			events.push(`get:${String(key)}`);
			collectGarbage();
			return object[key];
		},
	});
	rows.push(globalThis.readRecordSum(proxy), events.slice());
	const callableTarget = Object.assign(function callable() {}, target);
	const callableProxy = new Proxy(callableTarget, {
		get(object, key) {
			events.push(`callable:${String(key)}`);
			collectGarbage();
			return object[key];
		},
	});
	rows.push(globalThis.readRecordSum(callableProxy), events.slice());
	const accessor = {
		get x() {
			events.push("getter");
			collectGarbage();
			this.y = 20;
			return 1;
		},
		y: 2,
		z: 3,
		w: 4,
		v: 5,
	};
	rows.push(globalThis.readRecordSum(accessor), events.slice());
	const coercing = {
		x: {
			valueOf() {
				events.push("coerce");
				collectGarbage();
				coercing.z = 30;
				return 1;
			},
		},
		y: 2,
		z: 3,
		w: 4,
		v: 5,
	};
	rows.push(globalThis.readRecordSum(coercing), events.slice());
	rows.push(globalThis.readRecordSum({ x: "x", y: 2, z: 3, w: 4, v: 5 }));
	const sentinel = {};
	let thrown = 0;
	try {
		globalThis.readRecordSum({
			get x() {
				events.push("throw");
				throw sentinel;
			},
			y: 2,
			z: 3,
			w: 4,
			v: 5,
		});
	} catch (error) {
		if (error === sentinel) thrown++;
	}
	if (thrown !== 1 || events.filter((x) => x === "throw").length !== 1)
		throw new Error("replayed read");
	rows.push(thrown, events.slice());
	const changing = { x: 1, y: 2, z: 3, w: 4, v: 5 };
	for (let i = 0; i < 3; i++) rows.push(globalThis.readRecordSum(changing));
	delete changing.z;
	Object.setPrototypeOf(changing, { z: 30 });
	rows.push(globalThis.readRecordSum(changing));
	const wideObject = fields();
	Object.defineProperty(wideObject, "f20", {
		get() {
			events.push("wide getter");
			collectGarbage();
			wideObject.f35 = 100;
			return 20;
		},
	});
	rows.push(globalThis.readRecordWide(wideObject), events.slice());
	const lateObject = fields();
	for (let i = 0; i < 3; i++) globalThis.readRecordWide(lateObject);
	let lateReads = 0;
	Object.defineProperty(lateObject, "f35", {
		get() {
			lateReads++;
			collectGarbage();
			lateObject.f0 = 1000;
			return 16;
		},
	});
	const lateResult = globalThis.readRecordWide(lateObject);
	if (lateResult !== 20 || lateReads !== 1 || lateObject.f0 !== 1000)
		throw new Error("replayed numeric prefix");
	rows.push(lateResult, lateReads, lateObject.f0);
} else if (mode === "wide" || mode === "update") {
	const record = fields();
	for (let i = 0; i < 5; i++) {
		const result =
			mode === "wide"
				? globalThis.readRecordWide(record)
				: globalThis.updateWideRecord(record, i === 0 ? 0.5 : 1.25);
		rows.push([scalar(result), scalar(record.f0), scalar(record.f23)]);
		collectGarbage();
	}
} else {
	const variants = [
		[-0, -0, -0, -0],
		[1, 2, 3, 4],
		[4, 3, 2, 1],
		[Infinity, 1, 2, 3],
		[NaN, 1, 2, 3],
		[-Infinity, Infinity, 1, 2],
	];
	const children = [];
	for (let round = 0; round < 4; round++)
		for (const values of variants) {
			let record;
			if (mode === "function") record = function receiver() {};
			else if (mode === "bound") record = function receiver() {}.bind(null);
			else if (mode === "native")
				new Promise((resolve) => {
					record = resolve;
				});
			else record = {};
			Object.assign(record, {
				x: values[0],
				y: values[1],
				z: values[2],
				w: values[3],
				v: 5,
			});
			if (mode === "frozen") Object.freeze(record);
			if (mode === "prototype") children.push(Object.create(record));
			rows.push(
				scalar(
					mode === "branch"
						? globalThis.readRecordBranch(record)
						: globalThis.readRecordSum(record),
				),
			);
			collectGarbage();
		}
	if (mode === "prototype" && children[0].x !== 0) throw new Error("prototype changed");
}
console.log(JSON.stringify(rows));
