function getConsole() {
	return (() => {
		"use strict";
		return this.console;
	})();
}

getConsole().log(["from receiver"]);
