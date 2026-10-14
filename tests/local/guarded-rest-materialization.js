const collect = globalThis.__mal_collect_garbage || globalThis.gc || (() => {});
function check(condition, message) {
	if (!condition) throw new Error(message);
}

let action = () => true;
globalThis.gate = {
	get enabled() {
		return action();
	},
};
globalThis.guardedRest = function guardedRest(...args) {
	if (!globalThis.gate.enabled) return false;
	globalThis.reader = () => args;
	return args;
};
globalThis.transitiveRest = function transitiveRest(...args) {
	if (!globalThis.gate.enabled) return false;
	globalThis.factory = () => () => args;
	return args;
};
globalThis.earlyRest = function earlyRest(...args) {
	globalThis.reader = () => args;
	if (!globalThis.gate.enabled) return false;
	return args;
};
globalThis.earlyTransitiveRest = function earlyTransitiveRest(...args) {
	globalThis.factory = () => () => args;
	if (!globalThis.gate.enabled) return false;
	return args;
};
globalThis.handledRest = function handledRest(...args) {
	try {
		if (!globalThis.gate.enabled) return false;
		globalThis.reader = () => args;
		return args;
	} catch {
		return args;
	}
};
globalThis.unmappedRest = function unmappedRest(...args) {
	arguments[0] = { id: -1 };
	if (!globalThis.gate.enabled) return false;
	globalThis.reader = () => args;
	return args;
};
globalThis.lateArgumentsRest = function lateArgumentsRest(...args) {
	if (!globalThis.gate.enabled) return false;
	globalThis.reader = () => args;
	args.length = 0;
	collect();
	return arguments[0];
};

let reads = 0;
for (let index = 0; index < 30; index++) {
	let supplied = [{ id: index }, { id: index + 1 }];
	action = () => {
		reads++;
		supplied.length = 0;
		collect();
		return true;
	};
	const result = globalThis.guardedRest.apply(null, supplied);
	check(result[0].id === index && result[1].id === index + 1, "argument snapshot");
	collect();
	check(globalThis.reader() === result, "escaped rest identity");
	result[0] = { id: -index };
	check(globalThis.reader()[0].id === -index, "escaped rest mutation");
	action = () => {
		reads++;
		collect();
		return false;
	};
	check(globalThis.guardedRest({ id: index }) === false, "disabled guard");
	collect();
}
check(reads === 60, "getter invocation count");

action = () => {
	collect();
	throw new Error("guard failure");
};
let thrown = false;
try {
	globalThis.guardedRest({ id: 77 });
} catch (error) {
	thrown = error.message === "guard failure";
}
check(thrown, "guard exception");
collect();
check(globalThis.handledRest({ id: 78 })[0].id === 78, "catch observes initialized rest");

action = () => {
	collect();
	check(globalThis.reader()[0].id === 81, "early observer");
	return false;
};
check(globalThis.earlyRest({ id: 81 }) === false, "early observer guard");
action = () => {
	collect();
	check(globalThis.factory()()[0].id === 82, "early transitive observer");
	return false;
};
check(globalThis.earlyTransitiveRest({ id: 82 }) === false, "early factory guard");

action = () => true;
const transitive = globalThis.transitiveRest({ id: 83 });
collect();
check(globalThis.factory()() === transitive, "escaped transitive identity");
action = () => {
	collect();
	return true;
};
check(globalThis.unmappedRest({ id: 84 })[0].id === 84, "unmapped arguments snapshot");
check(globalThis.lateArgumentsRest({ id: 85 }).id === 85, "later incoming argument read");

let nesting = 0;
let inner;
action = () => {
	if (nesting++ === 0) inner = globalThis.guardedRest({ id: 91 });
	collect();
	return true;
};
const outer = globalThis.guardedRest({ id: 92 });
check(
	inner !== outer && inner[0].id === 91 && outer[0].id === 92,
	"reentrant activation",
);
collect();
console.log("rest-materialization PASS");
