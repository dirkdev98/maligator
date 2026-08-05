import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

const nameDescriptor = Object.getOwnPropertyDescriptor(
	AsyncLocalStorage.prototype,
	"name",
);
check(
	AsyncLocalStorage.length === 0 &&
		AsyncLocalStorage.prototype.withScope.length === 1 &&
		nameDescriptor?.get?.name === "get name",
	"Node 26 API metadata",
);

const storage = new AsyncLocalStorage({
	defaultValue: "fallback",
	name: 26,
});
check(
	storage.name === "26" && storage.getStore() === "fallback",
	"constructor name and defaultValue",
);
check(new AsyncLocalStorage().name === "", "default name");

storage.run("active", () => {
	check(storage.getStore() === "active", "run overrides defaultValue");
	storage.exit(() => {
		check(storage.getStore() === undefined, "exit binds explicit undefined");
	});
	check(storage.getStore() === "active", "exit restores active store");
});
check(storage.getStore() === "fallback", "run restores defaultValue");

storage.enterWith("disabled");
storage.disable();
check(storage.getStore() === "fallback", "disable reveals defaultValue");
storage.exit(() => {
	check(storage.getStore() === undefined, "exit masks defaultValue while disabled");
});
check(storage.getStore() === "fallback", "disabled exit restores defaultValue");

let getterError;
try {
	new AsyncLocalStorage({
		get defaultValue() {
			throw "getter-error";
		},
	});
} catch (error) {
	getterError = error;
}
check(getterError === "getter-error", "constructor preserves getter abrupt completion");

for (const options of [null, [], () => {}]) {
	let rejected = false;
	try {
		new AsyncLocalStorage(options);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "constructor rejects invalid options");
}

const scope = storage.withScope("scope");
const scopePrototype = Object.getPrototypeOf(scope);
check(storage.getStore() === "scope", "withScope enters store");
check(
	scopePrototype.constructor.name === "RunScope" &&
		scope.dispose.name === "dispose" &&
		scope.dispose.length === 0 &&
		scope[Symbol.dispose].name === "[Symbol.dispose]" &&
		scope[Symbol.dispose].length === 0,
	"RunScope metadata",
);
check(
	Object.keys(scope).length === 0 && scope.dispose !== scope[Symbol.dispose],
	"RunScope private state and disposal methods",
);
scope[Symbol.dispose]();
check(storage.getStore() === "fallback", "Symbol.dispose restores prior store");
scope.dispose();
check(storage.getStore() === "fallback", "RunScope disposal is idempotent");

storage.enterWith("outer");
const outerScope = storage.withScope("middle");
const innerScope = storage.withScope("inner");
check(storage.getStore() === "inner", "nested scope enters inner store");
innerScope.dispose();
check(storage.getStore() === "middle", "inner scope restores middle store");
outerScope.dispose();
check(storage.getStore() === "outer", "outer scope restores original store");
storage.disable();

const bound = AsyncResource.bind(() => 1);
check(
	!Object.hasOwn(bound, "asyncResource"),
	"Node 26 omits deprecated bound asyncResource property",
);

let nameBrandError = false;
try {
	nameDescriptor.get.call({});
} catch (error) {
	nameBrandError = error instanceof TypeError;
}
check(nameBrandError, "name getter brand check");

let scopeBrandError = false;
try {
	AsyncLocalStorage.prototype.withScope.call({}, "store");
} catch (error) {
	scopeBrandError = error instanceof TypeError;
}
check(scopeBrandError, "withScope brand check");

console.log("RESULT " + passed + "/" + total);
