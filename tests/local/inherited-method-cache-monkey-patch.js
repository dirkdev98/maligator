function callGetTime(date) {
	return date.getTime();
}

const date = new Date(7);
for (let i = 0; i < 100; i++) {
	if (callGetTime(date) !== 7) throw new Error("warm failure");
}
Date.prototype.getTime = function () {
	return 71;
};
if (callGetTime(date) !== 71) throw new Error("monkey patch was not observed");
console.log("inherited-method-cache-monkey-patch PASS");
