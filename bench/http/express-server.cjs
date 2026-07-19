"use strict";

const { listen } = require("../../tests/fixtures/express-5/app.js");

const port = Number(process.env.PORT) || 0;
listen(port).then(
	() => console.log(`PORT ${port}`),
	(error) => {
		console.error(error);
		process.exitCode = 1;
	},
);
