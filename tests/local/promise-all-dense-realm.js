const remote = $262.createRealm().global;
const inputs = new remote.Array();
inputs.push(remote.Promise.resolve(11), remote.Promise.resolve(22));
const checks = [];
function check(values, expected, prototype) {
	if (values.join(",") !== expected || Object.getPrototypeOf(values) !== prototype) {
		throw new Error("Promise.all realm mismatch");
	}
}
checks.push(
	Promise.all([inputs[0], Promise.resolve(33)]).then((values) => {
		check(values, "11,33", Array.prototype);
	}),
);
checks.push(
	remote.Promise.all(inputs).then((values) => {
		check(values, "11,22", remote.Array.prototype);
	}),
);
checks.push(
	Promise.all.call(remote.Promise, inputs).then((values) => {
		check(values, "11,22", Array.prototype);
	}),
);
let releaseRemote, releaseLocal;
const remotePending = new remote.Promise((resolve) => {
	releaseRemote = resolve;
});
const localPending = new Promise((resolve) => {
	releaseLocal = resolve;
});
const remoteRejected = remote.Promise.reject("reason");
const remoteValue = new remote.Object();
remoteValue.label = "remote";
function checkRecords(values, arrayPrototype, recordPrototype) {
	if (
		Object.getPrototypeOf(values) !== arrayPrototype ||
		Object.getPrototypeOf(values[0]) !== recordPrototype ||
		Object.getPrototypeOf(values[1]) !== recordPrototype ||
		values[0].status !== "fulfilled" ||
		values[0].value !== remoteValue ||
		values[1].status !== "rejected" ||
		values[1].reason !== "reason"
	) {
		throw new Error("Promise.allSettled realm mismatch");
	}
}
checks.push(
	remote.Promise.allSettled(new remote.Array(remotePending, remoteRejected)).then(
		(values) => {
			checkRecords(values, remote.Array.prototype, remote.Object.prototype);
		},
	),
);
checks.push(
	Promise.allSettled
		.call(remote.Promise, new remote.Array(remotePending, remoteRejected))
		.then((values) => {
			checkRecords(values, Array.prototype, Object.prototype);
		}),
);
function checkError(error, errorPrototype, arrayPrototype) {
	if (
		Object.getPrototypeOf(error) !== errorPrototype ||
		Object.getPrototypeOf(error.errors) !== arrayPrototype ||
		error.errors[0] !== "reason"
	) {
		throw new Error("Promise.any realm mismatch");
	}
}
checks.push(
	remote.Promise.any(new remote.Array(remoteRejected)).then(
		() => {
			throw new Error("Promise.any unexpectedly fulfilled");
		},
		(error) => checkError(error, remote.AggregateError.prototype, remote.Array.prototype),
	),
);
checks.push(
	Promise.any.call(remote.Promise, new remote.Array(remoteRejected)).then(
		() => {
			throw new Error("Promise.any unexpectedly fulfilled");
		},
		(error) => checkError(error, AggregateError.prototype, Array.prototype),
	),
);
checks.push(
	remote.Promise.race(new remote.Array(remotePending)).then((value) => {
		if (value !== remoteValue) throw new Error("Promise.race identity mismatch");
	}),
);
checks.push(
	Promise.allSettled([localPending]).then((values) => {
		if (
			Object.getPrototypeOf(values) !== Array.prototype ||
			Object.getPrototypeOf(values[0]) !== Object.prototype ||
			values[0].value !== 31
		) {
			throw new Error("Promise.allSettled caller realm mismatch");
		}
	}),
);
Promise.resolve().then(() => {
	releaseRemote(remoteValue);
	releaseLocal(31);
});
Promise.all(checks).then(() => print("promise-all-dense-realm PASS"));
