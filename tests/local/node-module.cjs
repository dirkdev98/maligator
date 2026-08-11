const { createRequire } = require("node:module");

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const localRequire = createRequire("/tmp/application/entry.js");
check("createRequire returns a callable", typeof localRequire === "function");
check("require exposes resolve", typeof localRequire.resolve === "function");

let message = "";
try {
	localRequire.resolve("dynamic-package");
} catch (error) {
	message = error.message;
}
check(
	"dynamic resolution explains the image boundary",
	message.includes("ahead-of-time image"),
);

for (const [name, ok] of results) {
	if (!ok) console.log(`FAIL: ${name}`);
}
console.log(`RESULT ${results.filter(([, ok]) => ok).length}/${results.length}`);
