let thrown;
try {
	new ShadowRealm().evaluate("1");
} catch (error) {
	thrown = error;
}

if (!(thrown instanceof EvalError)) {
	throw new Error("ShadowRealm eval policy failure must be a caller-realm EvalError");
}

console.log("shadow-realm-eval-disabled PASS");
