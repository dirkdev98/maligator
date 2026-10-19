// The free performance global carries Node's perf_hooks surface without an import.
const mark = performance.mark("start", { detail: { step: 1 } });
const measure = performance.measure("span", "start");
console.log(
	JSON.stringify([
		mark.constructor.name,
		mark.detail,
		measure.entryType,
		performance.getEntriesByType("mark").length,
		typeof PerformanceObserver,
		mark instanceof PerformanceEntry,
		typeof performance.timerify,
	]),
);
