function callGetTime(date) {
	return date.getTime();
}

const originalValues = Array.prototype.values;
function replacementValues() {
	return "replacement values";
}
function loadValuesAcrossMutation(receiver) {
	let loaded;
	for (let i = 0; i < 100; i++) {
		loaded = receiver.values;
		if (i === 50) Array.prototype.values = replacementValues;
	}
	return loaded;
}
if (loadValuesAcrossMutation([]) !== replacementValues)
	throw new Error("watched loop epoch did not observe mutation");
Array.prototype.values = originalValues;

const date = new Date(7);
for (let i = 0; i < 100; i++) {
	if (callGetTime(date) !== 7) throw new Error("warm failure");
}
Date.prototype.getTime = function () {
	return 71;
};
if (callGetTime(date) !== 71) throw new Error("monkey patch was not observed");
console.log("inherited-method-cache-monkey-patch PASS");
