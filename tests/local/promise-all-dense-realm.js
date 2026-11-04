const realm = $262.createRealm();
const remote = realm.global;
const inputs = new remote.Array();
inputs.push(remote.Promise.resolve(11), remote.Promise.resolve(22));
let remaining = 3;
function check(values, expected, prototype) {
	if (values.join(",") !== expected || Object.getPrototypeOf(values) !== prototype) {
		throw new Error("Promise.all realm mismatch");
	}
	if (--remaining === 0) print("promise-all-dense-realm PASS");
}
Promise.all([inputs[0], Promise.resolve(33)]).then((values) => {
	check(values, "11,33", Array.prototype);
});
remote.Promise.all(inputs).then((values) => {
	check(values, "11,22", remote.Array.prototype);
});
Promise.all.call(remote.Promise, inputs).then((values) => {
	check(values, "11,22", Array.prototype);
});
