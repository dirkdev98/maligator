import {
	Performance,
	PerformanceEntry,
	PerformanceMark,
	PerformanceMeasure,
	PerformanceObserver,
	PerformanceObserverEntryList,
	constants,
	createHistogram,
	performance,
	timerify,
} from "node:perf_hooks";

function report(label, fn) {
	try {
		console.log(label, fn());
	} catch (error) {
		console.log(label, "throws", error.name, error.code, error.message);
	}
}

console.log(
	"global",
	globalThis.performance === performance,
	performance instanceof Performance,
);
console.log(
	"clock",
	typeof performance.now(),
	performance.now() >= 0,
	typeof performance.timeOrigin,
);
const first = performance.mark("first", { detail: { step: 1 } });
console.log(
	"mark",
	first instanceof PerformanceMark,
	first instanceof PerformanceEntry,
	first.name,
	first.entryType,
	first.duration,
	JSON.stringify(first.detail),
	Object.keys(first).length,
	Object.prototype.toString.call(first),
);
const fixed = performance.mark("fixed", { startTime: 5 });
console.log("mark startTime", fixed.startTime, JSON.stringify(fixed.toJSON()));
performance.mark("later", { startTime: 25 });
const between = performance.measure("between", "fixed", "later");
console.log(
	"measure marks",
	between instanceof PerformanceMeasure,
	between.startTime,
	between.duration,
	between.detail,
);
const options = performance.measure("options", { start: 10, end: 40, detail: "d" });
console.log("measure options", options.startTime, options.duration, options.detail);
const durationOnly = performance.measure("duration", { start: "fixed", duration: 3 });
console.log("measure duration", durationOnly.startTime, durationOnly.duration);
const fromStart = performance.measure("from-start", { end: 30 });
console.log("measure end", fromStart.startTime, fromStart.duration);
console.log("measure open", performance.measure("open", "fixed").startTime);
report("measure missing", () => performance.measure("x", "nope"));
report("measure endMark", () => performance.measure("x", { start: 1, end: 2 }, "later"));
report("measure all", () => performance.measure("x", { start: 1, end: 2, duration: 1 }));
report("mark negative", () => performance.mark("a", { startTime: -1 }));
console.log(
	"entries",
	performance
		.getEntries()
		.filter((entry) => entry.name !== "first")
		.map((entry) => `${entry.entryType}:${entry.name}`)
		.join(),
);
console.log(
	"by name",
	performance.getEntriesByName("fixed").length,
	performance.getEntriesByName("between", "measure").length,
);
console.log(
	"by type",
	performance
		.getEntriesByType("mark")
		.map((entry) => entry.name)
		.filter((name) => name !== "first")
		.join(),
);
performance.clearMarks("first");
console.log(
	"clear one",
	performance
		.getEntriesByType("mark")
		.map((entry) => entry.name)
		.join(),
);
performance.clearMeasures();
console.log("clear measures", performance.getEntriesByType("measure").length);
performance.clearMarks();
console.log("clear marks", performance.getEntries().length);
console.log("toJSON", JSON.stringify(Object.keys(performance.toJSON())));
console.log(
	"nodeTiming",
	performance.nodeTiming.name,
	performance.nodeTiming.entryType,
	performance.nodeTiming.loopExit,
);
const utilization = performance.eventLoopUtilization();
console.log(
	"elu",
	JSON.stringify(Object.keys(utilization)),
	typeof utilization.utilization,
);

report("observer callback", () => new PerformanceObserver(1));
report("observer options", () => new PerformanceObserver(() => {}).observe({}));
report("observer both", () =>
	new PerformanceObserver(() => {}).observe({ entryTypes: ["mark"], type: "mark" }),
);
console.log("supported", PerformanceObserver.supportedEntryTypes.join());

await new Promise((resolve) => {
	const observer = new PerformanceObserver((list, self) => {
		console.log(
			"observed",
			list instanceof PerformanceObserverEntryList,
			self === observer,
			list
				.getEntries()
				.map((entry) => `${entry.entryType}:${entry.name}`)
				.join(),
			list.getEntriesByType("measure").length,
			list.getEntriesByName("one").length,
		);
		observer.disconnect();
		resolve();
	});
	observer.observe({ entryTypes: ["mark", "measure"] });
	performance.mark("one", { startTime: 1 });
	performance.mark("two", { startTime: 2 });
	performance.measure("span", "one", "two");
	console.log("observer pending", observer.takeRecords().length);
	performance.mark("three", { startTime: 3 });
	console.log("observer sync");
});

performance.mark("before-buffered", { startTime: 7 });
await new Promise((resolve) => {
	const observer = new PerformanceObserver((list) => {
		console.log(
			"buffered",
			list
				.getEntries()
				.map((entry) => entry.name)
				.join(),
		);
		observer.disconnect();
		resolve();
	});
	observer.observe({ type: "mark", buffered: true });
});

const doubled = timerify(function double(value) {
	return value * 2;
});
console.log("timerify", doubled.name, doubled.length, doubled(21));
await new Promise((resolve) => {
	const observer = new PerformanceObserver((list) => {
		const [entry] = list.getEntries();
		console.log(
			"function entry",
			entry.entryType,
			entry.name,
			JSON.stringify(entry.detail),
			entry.duration >= 0,
		);
		observer.disconnect();
		resolve();
	});
	observer.observe({ entryTypes: ["function"] });
	doubled(4);
});

const histogram = createHistogram();
console.log(
	"histogram empty",
	histogram.min,
	histogram.max,
	histogram.mean,
	histogram.stddev,
	histogram.count,
	histogram.exceeds,
);
histogram.record(5);
histogram.record(15);
console.log(
	"histogram",
	histogram.min,
	histogram.max,
	histogram.mean,
	histogram.stddev,
	histogram.count,
);
report("histogram record", () => histogram.record(0));
histogram.reset();
console.log(
	"histogram reset",
	histogram.count,
	Object.getPrototypeOf(histogram).constructor.name,
);
console.log(
	"constants",
	constants.NODE_PERFORMANCE_GC_MAJOR,
	constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE,
);

const source = { nested: [1, 2] };
const cloned = performance.mark("cloned", { detail: source });
source.nested.push(3);
console.log("detail cloned", JSON.stringify(cloned.detail), cloned.detail !== source);
try {
	performance.mark("bad", { detail: () => {} });
} catch (error) {
	console.log("detail uncloneable", error.name, error.code);
}
console.log(
	"nodeTiming json",
	JSON.stringify(Object.keys(performance.nodeTiming.toJSON())),
);
