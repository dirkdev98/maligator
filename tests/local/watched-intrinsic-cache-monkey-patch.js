function callFloor(value) {
	return Math.floor(value);
}

for (let i = 0; i < 100; i++) {
	if (callFloor(7.9) !== 7) throw new Error("warm failure");
}
Math.floor = function () {
	return 71;
};
if (callFloor(7.9) !== 71) throw new Error("monkey patch was not observed");
console.log("watched-intrinsic-cache-monkey-patch PASS");
