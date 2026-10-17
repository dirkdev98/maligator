let passed = 0;

function check(name, actual, expected) {
	if (!Object.is(actual, expected)) {
		throw new Error("FAIL " + name + ": got " + Object.prototype.toString.call(actual));
	}
	passed++;
}

function strictCallee() {
	return this;
}

function callCallerBindings() {
	const localCallee = function () {
		return this;
	};
	check("module function called from eval", eval("strictCallee()"), undefined);
	check("local function called from eval", eval("localCallee()"), undefined);
	check(
		"eval-declared function",
		eval("function declared() { return this; } declared()"),
		undefined,
	);
}
callCallerBindings();

const sloppy = Function(`
	function sloppyCallee() { return this; }
	const withObject = { method() { return this; } };
	const results = { sloppy: eval("sloppyCallee()") };
	with (withObject) {
		results.withBareMethod = method() === withObject;
	}
	results.withInsideEval = eval("with ({}) { sloppyCallee(); }");
	return results;
`)();
check("sloppy function called from eval", sloppy.sloppy, globalThis);
check("with-object method called directly", sloppy.withBareMethod, true);
check("eval-scope function called inside with", sloppy.withInsideEval, globalThis);

console.log("eval-call-this PASS " + passed + "/" + passed);
