const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const mode = process.env.OBSERVED_ENUM_MODE ?? "values";
function values(record, observe) {
	const snapshot = Object.values(record);
	observe(record);
	const output = [];
	for (let index = 0; index < snapshot.length; index++) output.push(snapshot[index]);
	return output;
}
function entries(record, observe) {
	const snapshot = Object.entries(record);
	const first = snapshot[0];
	observe(record, first);
	const output = [];
	for (let index = 0; index < snapshot.length; index++) output.push(snapshot[index]);
	if (first !== snapshot[0]) throw new Error("entry pair identity");
	return output;
}
globalThis.readObservedValues = values;
globalThis.readObservedEntries = entries;
const rows = [];
const marker = Symbol("retained");
function input(array, events) {
	const record = array ? [] : {};
	Object.defineProperty(record, "0", {
		configurable: true,
		enumerable: true,
		get() {
			events.push("get:0");
			delete record[2];
			Object.defineProperty(record, "hidden", { enumerable: true });
			record[9] = "excluded addition";
			collectGarbage();
			return { value: "first", marker };
		},
	});
	record[2] = "deleted";
	Object.defineProperty(record, "label", {
		configurable: true,
		enumerable: true,
		get() {
			events.push("get:label");
			record.last = { value: "new-last", marker };
			collectGarbage();
			return { value: "label", marker };
		},
	});
	Object.defineProperty(record, "hidden", {
		configurable: true,
		get() {
			events.push("get:hidden");
			collectGarbage();
			return { value: "hidden", marker };
		},
	});
	record.last = { value: "old-last", marker };
	Object.defineProperty(record, Symbol("ignored"), {
		configurable: true,
		enumerable: true,
		get() {
			throw new Error("Symbol getter");
		},
	});
	return record;
}
function summarize(value) {
	if (!value || value.marker !== marker) throw new Error("lost eager reference");
	return value.value;
}
if (mode === "values" || mode === "entries") {
	for (const array of [false, true])
		for (let iteration = 0; iteration < 4; iteration++) {
			const events = [];
			const record = input(array, events);
			const observe = (target, first) => {
				events.push("observe");
				for (const key of Reflect.ownKeys(target))
					if (key !== "length") delete target[key];
				if (first) first[1].value = "mutated-first";
				collectGarbage();
			};
			const result =
				mode === "values"
					? globalThis.readObservedValues(record, observe)
					: globalThis.readObservedEntries(record, observe);
			if (events.join() !== "get:0,get:label,get:hidden,observe")
				throw new Error("getter order: " + events);
			const values = mode === "values" ? result : result.map((pair) => pair[1]);
			const summary = values.map(summarize);
			const expected =
				mode === "values"
					? "first,label,hidden,new-last"
					: "mutated-first,label,hidden,new-last";
			if (summary.join() !== expected) throw new Error("eager values: " + summary);
			if (
				mode === "entries" &&
				result.map((pair) => pair[0]).join() !== "0,label,hidden,last"
			)
				throw new Error("entry keys");
			rows.push(summary);
		}
} else if (mode === "throw") {
	for (const read of [globalThis.readObservedValues, globalThis.readObservedEntries])
		for (const array of [false, true]) {
			const record = array ? [] : {};
			const original = { error: "original" };
			let calls = 0;
			Object.defineProperty(record, "0", {
				enumerable: true,
				get() {
					calls++;
					collectGarbage();
					return { value: "held", marker };
				},
			});
			Object.defineProperty(record, "1", {
				enumerable: true,
				get() {
					calls++;
					collectGarbage();
					throw original;
				},
			});
			let thrown;
			try {
				read(record, () => {
					throw new Error("observer after throw");
				});
			} catch (error) {
				thrown = error;
			}
			if (thrown !== original || calls !== 2)
				throw new Error("getter replay or exception replaced");
			rows.push(calls);
		}
} else if (mode === "reentry") {
	for (const read of [globalThis.readObservedValues, globalThis.readObservedEntries]) {
		let depth = 0,
			calls = 0;
		const inner = {
			get value() {
				calls++;
				collectGarbage();
				return { value: "inner", marker };
			},
		};
		const outer = {
			get value() {
				calls++;
				depth++;
				const result = globalThis.readObservedValues(inner, collectGarbage);
				depth--;
				return result[0];
			},
			get tail() {
				calls++;
				collectGarbage();
				return { value: "tail", marker };
			},
		};
		const result = read(outer, collectGarbage);
		const values =
			read === globalThis.readObservedValues ? result : result.map((pair) => pair[1]);
		if (depth !== 0 || calls !== 3 || values.map(summarize).join() !== "inner,tail")
			throw new Error("reentrant enumeration");
		rows.push(values.map(summarize));
	}
} else {
	for (const read of [globalThis.readObservedValues, globalThis.readObservedEntries]) {
		let calls = 0;
		const large = {
			get first() {
				calls++;
				collectGarbage();
				return { value: "large", marker };
			},
		};
		for (let index = 0; index < 32; index++) large[`field${index}`] = index;
		const result = read(large, collectGarbage);
		if (calls !== 1 || result.length !== 33) throw new Error("large fallback replay");
		rows.push(result.length);
		const events = [];
		const target = { first: { value: "proxy", marker } };
		const proxy = new Proxy(target, {
			ownKeys(value) {
				events.push("keys");
				return Reflect.ownKeys(value);
			},
			getOwnPropertyDescriptor(value, key) {
				events.push("desc:" + key);
				collectGarbage();
				return Object.getOwnPropertyDescriptor(value, key);
			},
			get(value, key) {
				events.push("get:" + key);
				collectGarbage();
				return value[key];
			},
		});
		read(proxy, () => events.push("observe"));
		if (events.join() !== "keys,desc:first,get:first,observe")
			throw new Error("proxy effects: " + events);
		rows.push(events);
	}
}
console.log(JSON.stringify(rows));
