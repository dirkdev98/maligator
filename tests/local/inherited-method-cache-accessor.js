function callGetTime(date) {
	return date.getTime();
}

const date = new Date(11);
for (let i = 0; i < 100; i++) {
	if (callGetTime(date) !== 11) throw new Error("warm failure");
}
let gets = 0;
Object.defineProperty(Date.prototype, "getTime", {
	configurable: true,
	get() {
		gets++;
		return function () {
			return 73;
		};
	},
});
if (callGetTime(date) !== 73 || callGetTime(date) !== 73 || gets !== 2) {
	throw new Error("accessor replacement was not observed per load");
}
console.log("inherited-method-cache-accessor PASS");
