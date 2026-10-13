globalThis.createBoundaryHelper = function createBoundaryHelper(method) {
	function callback(value, index) {
		globalThis.observedIndex = index;
		if (method === "filter") return true;
		return method === "flatMap" ? [index] : index;
	}
	return Iterator.prototype[method].call([1, 2, 3].values(), callback);
};
