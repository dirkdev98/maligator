const bare = require("buffer");
const canonical = require("node:buffer");

const results = [];
function check(name, value) {
	results.push([name, !!value]);
}

check("bare and canonical CommonJS identity", bare === canonical);
check("CommonJS, named, and global constructor identity", bare.Buffer === Buffer);
check("CommonJS default object API", bare.Buffer.from("ok").toString() === "ok");
check(
	"require cache identity",
	require("buffer") === bare && require("node:buffer") === bare,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
