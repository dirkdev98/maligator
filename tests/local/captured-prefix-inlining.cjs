"use strict";

const trace = [];
const saved = [];

function consume(layer, done) {
	const keys = layer.keys;
	if (!keys || keys.length === 0) return done();
	const read = () => keys[0];
	saved.push(read);
	return done(keys);
}

function visit(layer, next, depth) {
	try {
		return consume(layer, function (keys) {
			trace.push(keys ? keys[0] : "fast");
			if (keys && depth > 0) return visit(next, next, depth - 1);
			return depth;
		});
	} catch (reason) {
		trace.push("caught " + depth);
		throw reason;
	}
}

function visitAgain(layer) {
	return consume(layer, (keys) => {
		trace.push(keys ? keys[0] : "second");
		return 7;
	});
}

function visitSelected(layer, useConsumer) {
	const selected = useConsumer ? consume : undefined;
	return selected(layer, (keys) => trace.push(keys ? keys[0] : "selected"));
}

const failure = new Error("interrupt");
const throwingLayer = {
	get keys() {
		trace.push("throwing keys");
		throw failure;
	},
};
const getterLayer = {
	get keys() {
		trace.push("get keys");
		return {
			0: "getter value",
			get length() {
				trace.push("get length");
				return 1;
			},
		};
	},
};
const lengthGetterLayer = {
	keys: {
		get length() {
			trace.push("empty length");
			return 0;
		},
	},
};

globalThis.consumeCapturedPrefix = consume;
globalThis.visitCapturedPrefix = visit;
globalThis.visitCapturedPrefixAgain = visitAgain;
globalThis.visitSelectedCapturedPrefix = visitSelected;
visitSelected({ keys: [] }, true);
try {
	visitSelected({ keys: [] }, false);
} catch (reason) {
	trace.push(reason instanceof TypeError);
}
trace.push(visit({ keys: [] }, throwingLayer, 1));
trace.push(visit(getterLayer, { keys: [] }, 1));
trace.push(visitAgain(lengthGetterLayer));
trace.push(visitAgain({ keys: [] }));
try {
	visit({ keys: ["before throw"] }, throwingLayer, 1);
} catch (reason) {
	trace.push(reason === failure);
}
trace.push(visitAgain({ keys: ["after throw"] }));
trace.push(
	saved[0] !== saved[1],
	saved.map((read) => read()),
);
function consumesArguments(layer, done) {
	const keys = layer.keys;
	if (!keys) return done(arguments.length);
	saved.push(() => keys[0]);
	return done(keys.length);
}

function createsClosureFirst(layer, done) {
	const keys = layer.keys;
	saved.push(() => keys);
	if (!keys) return done("early");
	return done(keys.length);
}

function recursiveConsumer(layer, done) {
	const keys = layer.keys;
	if (!keys) return done("bottom");
	saved.push(() => keys[0]);
	return recursiveConsumer({ keys: null }, done);
}

function visitArguments(layer) {
	return consumesArguments(layer, (value) => trace.push(value));
}

function visitEarlyClosure(layer) {
	return createsClosureFirst(layer, (value) => trace.push(value));
}

function visitRecursive(layer) {
	return recursiveConsumer(layer, (value) => trace.push(value));
}

visitArguments({ keys: null });
visitEarlyClosure({ keys: null });
visitRecursive({ keys: ["recursive"] });
console.log(JSON.stringify(trace));
