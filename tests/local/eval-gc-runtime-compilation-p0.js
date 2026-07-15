let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function generatedBody(count) {
	let source = "let total = seed;";
	for (let i = 0; i < count; i++) {
		source += "{ let n" + i + " = " + i + "; total += n" + i + "; }";
	}
	return source + " $262.gc(); total;";
}

const generatedCount = 16;
const expected = 7 + ((generatedCount - 1) * generatedCount) / 2;
ok("indirect eval", (0, eval)("$262.gc(); ({ value: 40 + 2 }).value") === 42);

function runDirect(seed) {
	return eval(generatedBody(generatedCount));
}
ok("direct eval scope", runDirect(7) === expected);

let methods = "";
for (let i = 0; i < generatedCount; i++) {
	methods += "m" + i + "() { return " + i + "; }";
}
ok(
	"generated class eval",
	eval("class EvalGcClass {" + methods + "}; $262.gc(); new EvalGcClass().m15()") === 15,
);

const parameter = {
	toString() {
		$262.gc();
		return "left";
	},
};
const body = {
	toString() {
		$262.gc();
		return "$262.gc(); return { sum: left + right }.sum;";
	},
};
const dynamic = Function(parameter, "right", body);
ok("dynamic Function", dynamic(20, 22) === 42);

ok("evalScript completion", $262.evalScript("$262.gc(); 6 * 7") === 42);
$262.evalScript("$262.gc(); globalThis.evalGcScriptValue = { value: 42 };");
$262.gc();
ok("evalScript retained result", globalThis.evalGcScriptValue.value === 42);

console.log("eval-gc-runtime-compilation-p0 PASS " + passed + "/" + passed);
