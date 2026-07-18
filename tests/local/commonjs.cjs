let passed = 0;
let total = 0;

function check(condition) {
	total++;
	if (condition) passed++;
}

const barePath = require("path");
const canonicalPath = require("node:path");
check(barePath === canonicalPath);
check(typeof barePath.join === "function");

const identityA = require("./commonjs-identity.cjs");
const identityB = require("./commonjs-identity.cjs");
check(identityA === identityB);
check(identityA.loads === 1);

const cycleA = require("./commonjs-cycle-a.cjs");
const cycleB = require("./commonjs-cycle-b.cjs");
check(cycleA.bSawA === true);
check(cycleA.b === cycleB);
check(cycleB.a === cycleA);

globalThis.commonJsFailureAttempts = 0;
let firstFailure;
try {
	require("./commonjs-failure.cjs");
} catch (error) {
	firstFailure = error;
}
const retried = require("./commonjs-failure.cjs");
check(firstFailure instanceof Error);
check(retried.attempt === 2);

const data = require("./commonjs-data.json");
check(data.answer === 42 && data.nested.ok === true);
check(data.__proto__.own === true);
check(Object.getPrototypeOf(data) === Object.prototype);

const filenames = require("./commonjs-filenames.cjs");
check(__filename === __dirname + "/commonjs.cjs");
check(filenames.filename === __dirname + "/commonjs-filenames.cjs");
check(filenames.dirname === __dirname);
check(this === exports);

const esmA = require("./commonjs-esm.mjs");
const esmB = require("./commonjs-esm.mjs");
check(esmA === esmB);
check(esmA.named === 42);
check(esmA.default.value === "default");
check(globalThis.commonJsEsmLoads === 1);

console.log("RESULT " + passed + "/" + total);
