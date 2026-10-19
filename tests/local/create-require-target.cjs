exports.loads = globalThis.createRequireTargetLoads =
	(globalThis.createRequireTargetLoads ?? 0) + 1;
exports.name = require("node:path").basename(__filename);
