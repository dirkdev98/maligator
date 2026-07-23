const requestRealm = $262.createRealm();
requestRealm.global.expectedFunctionPrototype = Function.prototype;
requestRealm.evalScript(`
	globalThis.callbackRealmIsCorrect = false;
	Object.prototype.then = function (resolve, reject) {
		delete Object.prototype.then;
		globalThis.callbackRealmIsCorrect =
			Object.getPrototypeOf(resolve) === expectedFunctionPrototype &&
			Object.getPrototypeOf(reject) === expectedFunctionPrototype;
		resolve(47);
		reject(48);
		resolve(49);
	};
	globalThis.crossRealmIterator = (async function* () {
		await 0;
		yield 5;
	})();
`);

async function* localGenerator() {}
const localNext = Object.getPrototypeOf(localGenerator()).next;
const request = localNext.call(requestRealm.global.crossRealmIterator);
if (Object.getPrototypeOf(request) !== Promise.prototype) {
	throw new Error("request Promise used the generator realm");
}

request.then((value) => {
	if (value !== 47 || requestRealm.global.callbackRealmIsCorrect !== true) {
		throw new Error("request settlement lost its Promise realm");
	}
	console.log("async-generator-cross-realm-request PASS");
});
