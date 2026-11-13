// A CommonJS program where one dependency's direct evals see only their own scopes,
// while another module's hot patterns stay private to it.
const { capturedEnds, Meter, restTotal } = require("./hot.cjs");
const { sumRanges } = require("./ranges.mjs");
const scoped = require("./scoped.cjs");

const hot = [];
let restSum = 0;
let capturedSum = 0;
const meter = new Meter();
for (let index = 0; index < 400; index++) {
	restSum += restTotal(index, index & 3, 2, 3) + scoped.restUnseen(index, 1);
	capturedSum += capturedEnds([index, index + 1, index + 2]);
	meter.record(index & 7);
}
hot.push(sumRanges(300), restSum, capturedSum, meter.sampleTotal());

const seen = [];
let checksum = 0;
for (let index = 0; index < 200; index++) {
	checksum += scoped.readWriteLocals("local += 1; items.push(local); local * 2")[2];
	checksum += scoped.bumpModule(1);
	for (const value of scoped.evalSequence(index & 7)) checksum += value;
	checksum += scoped.restSeen(index & 3, 2);
	checksum += scoped.capturedSeen([index, 1], "head() * 2")[0];
}
seen.push(
	checksum,
	scoped.readWriteLocals("local = 'changed'; items.length = 0; typeof items"),
	[...scoped.evalSequence(5)],
	scoped.restSeen(1),
	scoped.restUnseen("a", "b"),
	scoped.capturedSeen([4, 5], "values = [9, 8, 7]; values.length"),
	scoped.capturedSeen(null, "typeof head"),
);
seen.push(
	scoped.supportsGenerators,
	scoped.topLevel,
	scoped.wrapperBindings(),
	scoped.exportThroughEval("first", 1),
	scoped.exportThroughEval("second", 2),
	scoped.exportsReplaced(),
	scoped.requireThroughEval(),
	scoped.rebindRequire(),
	scoped.oddArguments(),
	scoped.rebindTripled("tripled = (value) => 'patched:' + value"),
	scoped.defineVars(),
	scoped.shared(),
	scoped.strictVar(),
	scoped.argumentsThroughEval("one", 2, 3),
);

const counter = scoped.makeCounter();
for (let index = 0; index < 100; index++) counter.add(1);
counter.poke("captured = 'replaced'");
seen.push(counter.add(1), counter.peek());

const vault = new scoped.Vault();
let vaultSum = 0;
for (let index = 0; index < 100; index++) {
	vault.write(index);
	vaultSum += vault.read() + vault.secretTotal();
}
vault.write("s");
seen.push(vaultSum, vault.read(), vault.secretTotal(), vault.logTotal());

console.log(JSON.stringify({ hot, seen }));
