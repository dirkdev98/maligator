function check(label, condition) {
	if (!condition) throw new Error(label);
}

function lastStringIndex() {
	var x;
	for (x in "9") continue;
	return x;
}

function emptyArguments() {
	"use strict";
	var x = "unset";
	for (x in arguments) continue;
	return x;
}

check("for-in preserves the last property key", lastStringIndex() === "0");
check("empty for-in preserves the target", emptyArguments() === "unset");

console.log("register-allocation PASS 2/2");
