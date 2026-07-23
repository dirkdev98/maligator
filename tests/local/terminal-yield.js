const retained = [];

function* terminalWithArguments() {
	const captured = arguments;
	yield { first: captured[0], length: captured.length };
}

for (let i = 0; i < 4000; i++) {
	const generator = terminalWithArguments(i, i + 1, i + 2);
	const first = generator.next();
	if (first.done || first.value.first !== i || first.value.length !== 3) {
		throw new Error("terminal yield result " + i);
	}
	retained.push(generator);
}

const nextGenerator = terminalWithArguments(1, 2, 3);
nextGenerator.next();
const nextResult = nextGenerator.next("ignored");
if (!nextResult.done || nextResult.value !== undefined) throw new Error("completed next");

const returnGenerator = terminalWithArguments(1, 2, 3);
returnGenerator.next();
const returnResult = returnGenerator.return("returned");
if (!returnResult.done || returnResult.value !== "returned")
	throw new Error("completed return");

const throwGenerator = terminalWithArguments(1, 2, 3);
throwGenerator.next();
try {
	throwGenerator.throw("thrown");
	throw new Error("completed throw did not throw");
} catch (error) {
	if (error !== "thrown") throw error;
}

function* terminalEvalSplice() {
	const added = eval("(function () { return 31; })");
	yield added();
}
const evalGenerator = terminalEvalSplice();
const evalResult = evalGenerator.next();
if (evalResult.done || evalResult.value !== 31) throw new Error("terminal eval splice");
if (!evalGenerator.next().done) throw new Error("terminal eval completion");

function* sentValue() {
	return yield 7;
}
const sentGenerator = sentValue();
if (sentGenerator.next().value !== 7) throw new Error("sent first");
const sentResult = sentGenerator.next(11);
if (!sentResult.done || sentResult.value !== 11) throw new Error("sent continuation");

const effects = [];
function* continuation() {
	yield 13;
	effects.push("continued");
}
const continued = continuation();
continued.next();
continued.next();

function* withFinally() {
	try {
		yield 17;
	} finally {
		effects.push("finally");
	}
}
const finalized = withFinally();
finalized.next();
const finalResult = finalized.return(19);
if (!finalResult.done || finalResult.value !== 19) throw new Error("finally return");

function* withCatch() {
	try {
		yield 23;
	} catch (error) {
		effects.push(error);
		return 29;
	}
}
const caught = withCatch();
caught.next();
const caughtResult = caught.throw("caught");
if (!caughtResult.done || caughtResult.value !== 29) throw new Error("catch throw");

if (effects.join(",") !== "continued,finally,caught")
	throw new Error("effects " + effects);

console.log("terminal-yield PASS");
