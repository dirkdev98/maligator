import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { strictCommonjs } from "../src/strict-commonjs.ts";

RuleTester.describe = describe;
RuleTester.it = it;

function sloppy(output: string) {
	return { messageId: "sloppy", suggestions: [{ messageId: "addDirective", output }] };
}

new RuleTester().run("strict-commonjs", strictCommonjs, {
	valid: [
		{
			name: "a CommonJS file that starts with use strict",
			code: '"use strict";\nconst x = require("x");\nmodule.exports = x;',
		},
		{
			name: "ES modules are always strict",
			code: 'import x from "x";\nexport default x;',
		},
		{
			name: "import.meta marks an ES module",
			code: "console.log(import.meta.url);",
		},
		{
			name: "a script that reads no CommonJS binding is left alone",
			code: "console.log(1);",
		},
		{
			name: "a locally declared require is not the CommonJS one",
			code: 'function require(name) {\n\treturn name;\n}\nrequire("x");',
		},
	],
	invalid: [
		{
			name: "a sloppy file that reads require",
			code: 'const x = require("x");\nmodule.exports = x;',
			errors: [sloppy('"use strict";\nconst x = require("x");\nmodule.exports = x;')],
		},
		{
			name: "a sloppy .cjs file",
			code: "console.log(1);",
			filename: "entry.cjs",
			errors: [sloppy('"use strict";\nconsole.log(1);')],
		},
		{
			name: "use strict after a statement is not a directive",
			code: 'const a = 1;\n"use strict";\nmodule.exports = a;',
			errors: [sloppy('"use strict";\nconst a = 1;\n"use strict";\nmodule.exports = a;')],
		},
	],
});
