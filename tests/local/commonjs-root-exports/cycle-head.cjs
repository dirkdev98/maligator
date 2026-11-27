const tail = require("./cycle-tail.cjs");
module.exports = head;
head.tailSaw = tail.sawHead;
head.tailThrew = tail.threw;
head.later = tail.later;
function head(value) {
	return `head:${value}`;
}
