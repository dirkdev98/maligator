const { app } = require("../fixtures/express-5/app.js");

const server = app.listen(0, "127.0.0.1", () => {
	console.log("PORT " + server.address().port);
});
