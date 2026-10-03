import pure from "./pure.cjs";
import { startup } from "./startup-parent.mjs";

let checks = 0;
function check(value, label) {
	if (!value) throw new Error(label);
	checks++;
}
check(startup === 42, "startup waits for transitive TLA");
check(
	(await import("./pure.cjs")).default === pure,
	"static and dynamic CommonJS imports share cached exports",
);

const [task1, task2] = await Promise.all([import("./task.mjs"), import("./task.mjs")]);
check(
	task1 === task2 &&
		task1.value === 42 &&
		globalThis.taskCount === 1 &&
		globalThis.taskDepCount === 1,
	"concurrent imports share initialization and namespace",
);
task1.increment();
check(task2.value === 43, "namespace binding remains live");

let release;
globalThis.moduleGate = new Promise((resolve) => {
	release = resolve;
});
globalThis.releaseModuleGate = release;
const siblings = await import("./siblings.mjs");
check(siblings.value === 7, "independent siblings begin before a dependency is awaited");

const [cycleA, cycleB] = await Promise.all([
	import("./cycle-a.mjs"),
	import("./cycle-b.mjs"),
]);
check(
	cycleA.value === 42 &&
		cycleB.value === 41 &&
		globalThis.cycleACount === 1 &&
		globalThis.cycleBCount === 1,
	"async cycle uses DFS backedge without rerunning",
);

globalThis.moduleFailure = { marker: "cached" };
for (let iteration = 0; iteration < 2; iteration++) {
	let syncCaught = false;
	try {
		await import("./sync-failure.mjs");
	} catch (error) {
		syncCaught = error === undefined;
	}
	check(syncCaught, "undefined synchronous failure is cached");
	let asyncCaught = false;
	try {
		await import("./async-failure.mjs");
	} catch (error) {
		asyncCaught = error === globalThis.moduleFailure;
	}
	check(asyncCaught, "asynchronous failure identity is cached");
}
check(
	globalThis.syncFailureCount === 1 && globalThis.asyncFailureCount === 1,
	"failed modules never rerun",
);

const failures = await Promise.allSettled([
	import("./reject-cycle-a.mjs"),
	import("./reject-cycle-b.mjs"),
]);
check(
	failures.every(
		(result) =>
			result.status === "rejected" && result.reason === globalThis.moduleFailure,
	),
	"every external cycle import observes root failure",
);
let cycleRejected = false;
try {
	await import("./reject-cycle-b.mjs");
} catch (error) {
	cycleRejected = error === globalThis.moduleFailure;
}
check(cycleRejected, "completed cycle member retains component failure");

const [common1, common2] = await Promise.all([
	import("./common.cjs"),
	import("./common.cjs"),
]);
check(
	common1 === common2 &&
		common1.default(2) === 4 &&
		common1.named === 12 &&
		globalThis.commonCount === 1,
	"CommonJS namespace shares require cache",
);
common1.default.named = 13;
check(
	common2.named === 12 && common2.default.named === 13,
	"CommonJS named exports are snapshots while default retains object identity",
);
const assimilated = await import("./then-export.mjs");
check(assimilated === 77, "import promise resolves namespace thenable");
console.log(`RESULT ${checks}/${checks}`);
