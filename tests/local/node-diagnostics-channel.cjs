const diagnostics = require("node:diagnostics_channel");

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const tracing = diagnostics.tracingChannel("compat.trace");
check("no-subscriber fast path", tracing.hasSubscribers === false);
const receiver = { base: 40 };
const result = tracing.traceSync(
	function (left, right) {
		return this.base + left + right;
	},
	{ metadata: true },
	receiver,
	1,
	1,
);
check("traceSync forwards receiver and arguments", result === 42);

let propagated = false;
try {
	tracing.traceSync(() => {
		throw new Error("trace failure");
	}, {});
} catch (error) {
	propagated = error.message === "trace failure";
}
check("traceSync propagates callback errors", propagated);

for (const [name, ok] of results) {
	if (!ok) console.log(`FAIL: ${name}`);
}
console.log(`RESULT ${results.filter(([, ok]) => ok).length}/${results.length}`);
