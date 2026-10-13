const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
function keysAfterHandler(record, index, before, observe) {
	try {
		before();
	} catch (error) {}
	const result = Object.keys(record);
	observe(record);
	return [result[index], result.length, result[0], result[index]];
}
function valuesAfterHandler(record, index, before, observe) {
	try {
		before();
	} catch (error) {}
	const result = Object.values(record);
	observe(record);
	return [result[index], result.length, result[0], result[index]];
}
function keysInCatch(record, index, before, observe) {
	try {
		before();
	} catch (error) {
		const result = Object.keys(record);
		observe(record);
		return [result[index], result.length, result[0], result[index]];
	}
	return null;
}
function valuesInCatch(record, index, before, observe) {
	try {
		before();
	} catch (error) {
		const result = Object.values(record);
		observe(record);
		return [result[index], result.length, result[0], result[index]];
	}
	return null;
}
function crossingHandler(record, observe) {
	const result = Object.values(record);
	try {
		observe();
	} catch (error) {
		return result[0];
	}
	return result.length;
}
function protectedProducer(record) {
	try {
		const result = Object.values(record);
		return result[0];
	} catch (error) {
		return error.message;
	}
}
function finallyObserver(record, observe) {
	const result = Object.keys(record);
	try {
		observe();
	} finally {
		observe(result[0]);
	}
	return result.length;
}
function retryGeneration(records) {
	let previous;
	let text = "";
	for (let i = 0; i < records.length; i++) {
		try {
			const current = Object.values(records[i]);
			if (previous) text += previous[0].label + ";";
			previous = current;
		} catch (error) {
			text += previous[0].label + ":caught;";
		}
	}
	return text;
}
const probes = new Array(4);
probes[0] = keysAfterHandler;
probes[1] = valuesAfterHandler;
probes[2] = keysInCatch;
probes[3] = valuesInCatch;
const rows = [];
for (let i = 0; i < 32; i++) {
	const record = {
		first: { label: "held-" + i },
		second: { label: "second-" + i },
		third: i,
		fourth: "last",
	};
	const events = [];
	const before = () => {
		events.push("before");
		if (typeof gc === "function") gc();
		if ((i & 3) >= 2 || (i & 4) !== 0) throw new Error("prior");
	};
	const observe = (target) => {
		events.push("observe");
		target.first = { label: "replacement" };
		delete target.second;
		target.extra = "late";
		if (typeof gc === "function") gc();
	};
	const index =
		i < 16
			? 0
			: {
					toString() {
						events.push("key");
						if (typeof gc === "function") gc();
						return "0";
					},
				};
	const probe = probes[i & 3];
	const result = probe(record, index, before, observe);
	if (typeof gc === "function") gc();
	rows.push(
		result,
		(i & 1) === 0 ? result[0] === "first" : result[0].label === "held-" + i,
		result[0] === result[3],
		events.join(","),
	);
}
const effects = [];
const throwingRecord = {
	get first() {
		effects.push("getter");
		if (typeof gc === "function") gc();
		throw new Error("get-stop");
	},
};
rows.push(protectedProducer(throwingRecord));
const retried = new Array(3);
retried[0] = { first: { label: "previous" } };
retried[1] = throwingRecord;
retried[2] = { first: { label: "next" } };
rows.push(retryGeneration(retried));
rows.push(
	crossingHandler({ first: "retained" }, () => {
		throw new Error("cross");
	}),
);
try {
	finallyObserver({ first: 1 }, (key) => {
		effects.push(key === undefined ? "throw" : key);
		if (key === undefined) throw new Error("finally-stop");
	});
} catch (error) {
	rows.push(error.message);
}
rows.push(effects.join(","));
console.log(JSON.stringify(rows));
