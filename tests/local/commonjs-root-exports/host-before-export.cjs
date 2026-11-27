const path = require("node:path");
const basename = path.basename;
module.exports = leaf;
module.exports.original = basename;
function leaf(file) {
	return basename(file).toUpperCase();
}
