import asyncHooks, { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { readFile } from "node:fs";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

check(
	asyncHooks.AsyncLocalStorage === AsyncLocalStorage &&
		asyncHooks.AsyncResource === AsyncResource,
	"default and named exports",
);
check(
	AsyncLocalStorage.name === "AsyncLocalStorage" &&
		AsyncLocalStorage.length === 0 &&
		AsyncLocalStorage.bind.length === 1 &&
		AsyncLocalStorage.snapshot.length === 0,
	"constructor and static metadata",
);
check(
	AsyncLocalStorage.prototype.run.length === 2 &&
		AsyncLocalStorage.prototype.exit.length === 1 &&
		AsyncLocalStorage.prototype.enterWith.length === 1 &&
		AsyncLocalStorage.prototype.getStore.length === 0 &&
		AsyncLocalStorage.prototype.disable.length === 0,
	"prototype method metadata",
);

const first = new AsyncLocalStorage();
const second = new AsyncLocalStorage();
check(first.getStore() === undefined, "initial store is undefined");

const thisArg = { tag: "bound-this" };
const syncResult = first.run(
	"outer",
	function (a, b) {
		check(this === null, "run callback this is null");
		check(first.getStore() === "outer", "run exposes store synchronously");
		check(second.getStore() === undefined, "instances are independent");

		second.run("second", () => {
			check(
				first.getStore() === "outer" && second.getStore() === "second",
				"independent nested instances",
			);
			first.run("inner", () => {
				check(
					first.getStore() === "inner" && second.getStore() === "second",
					"same-instance nesting",
				);
			});
			check(first.getStore() === "outer", "nested run restores outer store");
			first.exit(() => {
				check(
					first.getStore() === undefined && second.getStore() === "second",
					"exit masks only its own store",
				);
				queueMicrotask(() => {
					check(first.getStore() === undefined, "exit propagates its mask");
				});
			});
			check(first.getStore() === "outer", "exit restores the outer store");
		});
		return a + b;
	},
	3,
	4,
);
check(syncResult === 7 && first.getStore() === undefined, "run result and restoration");

let abrupt;
try {
	first.run("throwing", () => {
		throw thisArg;
	});
} catch (error) {
	abrupt = error;
}
check(
	abrupt === thisArg && first.getStore() === undefined,
	"run preserves abrupt completion and restores",
);

const entered = new AsyncLocalStorage();
entered.enterWith("entered");
check(entered.getStore() === "entered", "enterWith persists synchronously");
entered.disable();
check(entered.getStore() === undefined, "disable exits current contexts");

first.run("old", () => {
	first.disable();
	check(first.getStore() === undefined, "disable hides an active store");
	first.run("new", () => {
		check(first.getStore() === "new", "run re-enables after disable");
	});
	check(first.getStore() === undefined, "disabled outer store does not resurrect");
});

const bound = first.run("bound-store", () =>
	AsyncLocalStorage.bind(function (value) {
		check(
			first.getStore() === "bound-store" && this === thisArg && value === 9,
			"static bind restores context, this, and arguments",
		);
		return value + 1;
	}),
);
check(
	first.run("other-store", () => bound.call(thisArg, 9)) === 10,
	"static bind forwards return value",
);

const snapshot = first.run("snapshot-store", () => AsyncLocalStorage.snapshot());
check(
	first.run("other-snapshot", () =>
		snapshot(
			(a, b) => {
				check(first.getStore() === "snapshot-store", "snapshot restores context");
				return a + b;
			},
			5,
			6,
		),
	) === 11,
	"snapshot forwards arguments and return value",
);

let resource;
first.run("resource-store", () => {
	resource = new AsyncResource("fixture");
});
first.run("resource-caller", () => {
	resource.runInAsyncScope(() => {
		check(first.getStore() === "resource-store", "AsyncResource restores capture");
	});
	const resourceBound = resource.bind(function (value) {
		check(
			first.getStore() === "resource-store" && this === thisArg && value === 12,
			"AsyncResource.bind restores context",
		);
	});
	resourceBound.call(thisArg, 12);
	check(
		resourceBound.asyncResource === resource ||
			!Object.hasOwn(resourceBound, "asyncResource"),
		"bound function compatibility surface",
	);
});

class DerivedStorage extends AsyncLocalStorage {}
const derived = new DerivedStorage();
check(
	derived instanceof DerivedStorage && derived instanceof AsyncLocalStorage,
	"derived construction",
);
derived.run("derived", () => {
	check(derived.getStore() === "derived", "derived instance store");
});

let brandError = false;
try {
	AsyncLocalStorage.prototype.getStore.call(Object.create(AsyncLocalStorage.prototype));
} catch (error) {
	brandError = error instanceof TypeError;
}
check(brandError, "prototype spoofing is rejected");

let resolvePending;
const pending = new Promise((resolve) => {
	resolvePending = resolve;
});
first.run("registered", () => {
	pending.then(() => {
		check(first.getStore() === "registered", "pending reaction captures registration");
	});
});
first.run("resolver", () => resolvePending());

first.run("microtask", () => {
	queueMicrotask(() => {
		check(first.getStore() === "microtask", "queueMicrotask propagation");
	});
	Promise.resolve().then(() => {
		check(first.getStore() === "microtask", "settled Promise propagation");
	});
	(async () => {
		await 1;
		check(first.getStore() === "microtask", "async-await propagation");
	})();
});

first.run("timer-one", () => {
	setTimeout(() => {
		check(first.getStore() === "timer-one", "setTimeout propagation");
	}, 0);
});
first.run("timer-two", () => {
	setTimeout(() => {
		check(first.getStore() === "timer-two", "overlapping timer isolation");
	}, 0);
});
first.run("immediate", () => {
	setImmediate(() => {
		check(first.getStore() === "immediate", "setImmediate propagation");
	});
});
first.run("filesystem", () => {
	readFile("package.json", "utf8", (error, source) => {
		check(
			error === null &&
				source.includes('"name": "maligator"') &&
				first.getStore() === "filesystem",
			"filesystem callback propagation",
		);
	});
});

setTimeout(() => {
	console.log("RESULT " + passed + "/" + total);
}, 10);
