import * as service from "./callee-namespace-dependency.mjs";
import * as self from "./callee-namespace.mjs";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error(`callee-namespace failure: ${name}`);
	checks++;
}

function throwsReferenceError(read) {
	try {
		read();
		return false;
	} catch (error) {
		return error instanceof ReferenceError;
	}
}

function invoke(value) {
	try {
		return service.run(value);
	} catch (error) {
		return error.message;
	}
}

ok("fixed export", service.fixed(5) === 605);
ok("initial export", invoke(5) === 705);
service.select(true);
ok("known reassignment", invoke(5) === 805);
service.install((value) => value + 900);
ok("opaque reassignment", invoke(5) === 905);
service.install(() => {
	throw new Error("namespace fallback throw");
});
ok("opaque throw", invoke(5) === "namespace fallback throw");
ok("namespace receiver", service.receiver() === service);
ok(
	"uninitialized export through a namespace value",
	throwsReferenceError(() => service.readLate(self)),
);
ok(
	"uninitialized export through the namespace binding",
	throwsReferenceError(() => self.late),
);
ok("check count", checks === 8);

console.log("callee-namespace PASS");

export let late = 1;
