"use strict";
globalThis.checkClosed = function () {
	return globalThis.settlement === "type-error";
};
globalThis.startBoundary = function startBoundary(arrayLike, limit) {
	globalThis.observed = [];
	globalThis.defined = [];
	globalThis.nextCalls = 0;
	globalThis.closeCalls = 0;
	globalThis.wideGets = 0;
	globalThis.settlement = "pending";
	globalThis.pendingNext = new Promise((resolve) => {
		globalThis.releaseNext = resolve;
	});
	globalThis.pendingClose = new Promise((resolve) => {
		globalThis.releaseClose = resolve;
	});
	const source = arrayLike
		? {
				length: 4294967297,
				0: pendingNext,
				get 4294967296() {
					globalThis.wideGets++;
					return 11;
				},
			}
		: {
				[Symbol.asyncIterator]() {
					return {
						next() {
							globalThis.nextCalls++;
							return nextCalls === 1 ? pendingNext : { done: true };
						},
						return() {
							globalThis.closeCalls++;
							return pendingClose;
						},
					};
				},
			};
	function Result() {
		return new Proxy(
			{},
			{
				defineProperty(target, key, desc) {
					globalThis.defined.push(key);
					return Reflect.defineProperty(target, key, desc);
				},
			},
		);
	}
	globalThis.boundaryResult = Array.fromAsync
		.call(Result, source, function (value, index) {
			globalThis.observed.push(index);
			return value;
		})
		.then(
			(result) => {
				globalThis.settlement = result;
			},
			(error) => {
				globalThis.settlement = error instanceof TypeError ? "type-error" : "wrong-error";
			},
		);
	globalThis.finishFirst = function () {
		releaseNext(arrayLike ? 7 : { value: 7, done: false });
	};
	globalThis.finishClose = function () {
		releaseClose({});
	};
	globalThis.checkBoundary = function () {
		if (limit)
			return (
				settlement === "pending" &&
				closeCalls === 1 &&
				nextCalls === 1 &&
				observed.join(",") === "9007199254740990" &&
				defined.join(",") === "9007199254740990"
			);
		if (arrayLike)
			return (
				settlement.length === 4294967297 &&
				settlement[4294967295] === 7 &&
				settlement[4294967296] === 11 &&
				observed.join(",") === "4294967295,4294967296" &&
				defined.join(",") === "4294967295,4294967296,length" &&
				wideGets === 1 &&
				closeCalls === 0
			);
		return (
			settlement.length === 4294967297 &&
			settlement[4294967296] === 7 &&
			observed.join(",") === "4294967296" &&
			defined.join(",") === "4294967296,length" &&
			nextCalls === 2 &&
			closeCalls === 0
		);
	};
};
