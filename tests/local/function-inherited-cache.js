// Inherited data reads on function receivers while their prototype chains change.

class Base {
	static create() {
		return "base";
	}
}
class Derived extends Base {}

const methods = {
	handle() {
		return "handled";
	},
};
function router() {}
Object.setPrototypeOf(router, methods);

function readCreate(target) {
	return target.create;
}
function readHandle(target) {
	return target.handle;
}
function readPrototype(target) {
	return target.prototype;
}

const lines = [];
let calls = 0;
for (let round = 0; round < 1000; round++) {
	calls += readCreate(Derived)() === "base" ? 1 : 0;
	calls += readHandle(router)() === "handled" ? 1 : 0;
}
lines.push(`steady ${calls}`);

Base.create = () => "replaced";
methods.handle = () => "rehandled";
lines.push(`mutated ${readCreate(Derived)()} ${readHandle(router)()}`);

Derived.create = () => "own";
lines.push(`shadowed ${readCreate(Derived)()} ${readCreate(Base)()}`);
delete Derived.create;
lines.push(`restored ${readCreate(Derived)()}`);

Object.setPrototypeOf(router, { handle: () => "reparented" });
lines.push(`reparented ${readHandle(router)()}`);

const bound = readHandle.bind(null);
lines.push(
	`bound ${typeof readCreate(bound)} ${readCreate(Object.setPrototypeOf(bound, Base))()}`,
);

function constructor() {}
const derivedFunction = Object.setPrototypeOf(function () {}, constructor);
lines.push(
	`prototype ${readPrototype(derivedFunction) === derivedFunction.prototype} ` +
		`${readPrototype(constructor) === constructor.prototype} ` +
		`${Object.getPrototypeOf(readPrototype(constructor)) === Object.prototype}`,
);
console.log(lines.join("\n"));
