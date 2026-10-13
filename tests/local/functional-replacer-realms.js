const foreign = $262.createRealm().global;
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function replace(receiver, search, callback) {
	return receiver.replaceAll(search, callback);
}
globalThis.forwardRealmReplacement = replace;
const callback = foreign.Function(
	"match",
	"offset",
	"source",
	"if(this!==globalThis)throw new Error('foreign this');return match.toUpperCase();",
);
const results = [];
results.push(globalThis.forwardRealmReplacement("x-x", "x", callback));
results.push(globalThis.forwardRealmReplacement("x-x", /x/g, callback));
const receiver = {
	replaceAll: foreign.String.prototype.replaceAll,
	toString() {
		return "x-x";
	},
};
results.push(
	globalThis.forwardRealmReplacement(
		receiver,
		"x",
		function local(match, offset, source) {
			"use strict";
			collectGarbage();
			if (this !== undefined || source !== "x-x" || arguments.length !== 3)
				throw new Error("local string arguments");
			return offset;
		},
	),
);
const regex = new foreign.RegExp("(x)", "g");
results.push(
	globalThis.forwardRealmReplacement(
		"x-x",
		regex,
		function localCapture(match, capture, offset, source) {
			"use strict";
			collectGarbage();
			if (this !== undefined || capture !== "x" || arguments.length !== 4)
				throw new Error("local regexp arguments");
			return offset;
		},
	),
);
console.log("replacer-realms", results.join("|"));
