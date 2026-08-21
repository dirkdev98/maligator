import * as service from "./callee-namespace-dependency.mjs";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error(`callee-namespace failure: ${name}`);
	checks++;
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
ok("check count", checks === 5);

console.log("callee-namespace PASS");
