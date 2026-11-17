const mode = process.env.CAPTURED_DATE_PARSE_CASE ?? "values";
const savedDate = Date;
const savedParse = Date.parse;
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const text = "2020-02-29T12:34:56.789Z";
const events = [];
function captured(value) {
	return Date.parse(String(value));
}
function followed(value) {
	return Date.parse(String(value)) + Date.parse(text);
}
function extra(value, prepare) {
	return Date.parse(String(value), prepare());
}
function ordinary(value) {
	return Date.parse(value);
}
function argument(record) {
	return Date.parse(record.input);
}
function ordinaryExtra(value, prepare) {
	return Date.parse(value, prepare());
}
function empty() {
	return Date.parse();
}
function shadow(Date, value) {
	return Date.parse(String(value));
}
globalThis.parserConsumers = {
	captured,
	followed,
	extra,
	ordinary,
	argument,
	ordinaryExtra,
	empty,
	shadow,
};
function value(action, result = text) {
	return {
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			action();
			collect();
			return result;
		},
	};
}
let result;
try {
	if (mode === "strings") {
		result = [
			ordinary(text),
			Number.isNaN(ordinary("invalid date")),
			ordinary(new String(text)),
		];
	} else if (mode === "argument-method" || mode === "argument-restore") {
		if (mode === "argument-restore") Date.parse = () => 73;
		const record = {
			get input() {
				events.push("get");
				Date.parse = mode === "argument-restore" ? savedParse : () => 71;
				collect();
				return text;
			},
		};
		result = [argument(record), ordinary(text), events];
	} else if (mode === "argument-throw") {
		const thrown = { label: "date input getter" };
		try {
			argument({
				get input() {
					events.push("get");
					collect();
					throw thrown;
				},
			});
		} catch (error) {
			result = [error === thrown, events];
		}
	} else if (mode === "ordinary-extra") {
		result = [
			ordinaryExtra(text, () => {
				events.push("extra");
				Date.parse = () => 79;
				collect();
			}),
			ordinary(text),
			events,
		];
	} else if (mode === "ordinary-extra-throw") {
		const thrown = { label: "date extra argument" };
		try {
			ordinaryExtra(text, () => {
				events.push("extra");
				throw thrown;
			});
		} catch (error) {
			result = [error === thrown, events];
		}
	} else if (mode === "values") {
		result = [
			captured(text),
			captured(value(() => {})),
			Number.isNaN(captured(Symbol("date"))),
			Number.isNaN(captured(value(() => {}, "invalid date"))),
			events,
		];
	} else if (mode === "empty") {
		result = Number.isNaN(empty());
	} else if (mode === "method") {
		result = [
			captured(
				value(() => {
					Date.parse = () => 17;
				}),
			),
			ordinary(text),
			events,
		];
	} else if (mode === "global") {
		result = [
			captured(
				value(() => {
					globalThis.Date = { parse: () => 19 };
				}),
			),
			ordinary(text),
			events,
		];
	} else if (mode === "accessor") {
		const selected = captured(
			value(() => {
				Object.defineProperty(Date, "parse", {
					configurable: true,
					get() {
						events.push("get");
						return () => {
							events.push("call");
							return 23;
						};
					},
				});
			}),
		);
		result = [selected, ordinary(text), events];
	} else if (mode === "later") {
		result = [
			followed(
				value(() => {
					Date.parse = () => 29;
				}),
			),
			events,
		];
	} else if (mode === "throw") {
		const thrown = { label: "date conversion" };
		try {
			captured(
				value(() => {
					Date.parse = () => {
						events.push("replacement");
						return 31;
					};
					throw thrown;
				}),
			);
		} catch (error) {
			result = [error === thrown, events];
		}
	} else if (mode === "extra") {
		result = [
			extra(
				value(() => {}),
				() => {
					events.push("extra");
					Date.parse = () => 37;
					collect();
				},
			),
			ordinary(text),
			events,
		];
	} else if (mode === "extra-throw") {
		const thrown = { label: "extra argument" };
		try {
			extra(
				value(() => {}),
				() => {
					events.push("extra");
					throw thrown;
				},
			);
		} catch (error) {
			result = [error === thrown, events];
		}
	} else if (mode === "unknown") {
		result = [
			ordinary(
				value(() => {
					Date.parse = () => 41;
				}),
			),
			ordinary(text),
			events,
		];
	} else if (mode === "symbol") {
		try {
			ordinary(Symbol("date"));
		} catch (error) {
			result = error.name;
		}
	} else if (mode === "shadow") {
		result = [
			shadow(
				{ parse: (input) => "shadow:" + input },
				value(() => {}),
			),
			events,
		];
	}
} finally {
	globalThis.Date = savedDate;
	Object.defineProperty(Date, "parse", {
		value: savedParse,
		writable: true,
		configurable: true,
	});
}
console.log(JSON.stringify(result));
