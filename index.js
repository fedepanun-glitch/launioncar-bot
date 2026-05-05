var express = require("express");
var app = express();
app.use(express.urlencoded({ extended: false }));
app.get("/", function(req, res) { res.send("Bot OK"); });
app.listen(process.env.PORT || 3000, function() { console.log("Servidor andando"); });
