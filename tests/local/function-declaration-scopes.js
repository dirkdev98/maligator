function duplicate(value) {
	const declared = value;
	function value() {
		return "earlier";
	}
	function value() {
		return "later";
	}
	return [declared(), arguments[0] === declared];
}

function parameterEnvironment(value, readParameter = () => value) {
	const declared = value;
	function value() {
		return "body";
	}
	return [declared(), readParameter()];
}

function annexB(enter) {
	const before = typeof block;
	let inside;
	if (enter) {
		inside = block();
		function block() {
			return "block";
		}
	}
	return [before, inside, typeof block, block?.()];
}

function namedArguments(value) {
	const declared = arguments;
	function arguments(value) {
		return arguments[0] === value;
	}
	return declared === arguments && declared(value);
}

function namedExpression() {
	const self = "outer";
	const expression = function self() {
		return self;
	};
	return [expression() === expression, self];
}

function suspendedReaders() {
	function read() {
		return "initial";
	}
	const closure = () => read();
	const generator = (function* () {
		yield read();
	})();
	const promise = (async () => {
		await 0;
		return read();
	})();
	read = () => "updated";
	return Promise.all([closure(), generator.next().value, promise]);
}

function throughEval(source) {
	function reflected() {
		return "initial";
	}
	const before = eval(source);
	return [before, reflected()];
}

function throughWith(object, intercepted) {
	function intercepted() {
		return "local";
	}
	let inside;
	with (object) {
		inside = intercepted();
		intercepted = () => "assigned";
	}
	return [inside, intercepted(), object.intercepted?.()];
}

const scriptTop = [
	globalThis.declarationScopeTop === declarationScopeTop,
	declarationScopeTop(),
];
function declarationScopeTop() {
	return "top";
}

suspendedReaders().then((readers) => {
	console.log(
		JSON.stringify({
			scriptTop,
			duplicate: duplicate("parameter"),
			parameterEnvironment: parameterEnvironment("parameter"),
			annexB: [annexB(false), annexB(true)],
			namedArguments: namedArguments("argument"),
			namedExpression: namedExpression(),
			readers,
			eval: throughEval('const before = reflected(); reflected = () => "eval"; before'),
			with: [throughWith({}), throughWith({ intercepted: () => "object" })],
		}),
	);
});
