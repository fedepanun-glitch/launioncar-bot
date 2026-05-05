cat > ~/Desktop/bot.js << "ENDOFFILE"
var express = require("express");
var app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
var PORT = process.env.PORT || 3000;
app.get("/", function(req, res) { res.json({ status: "ok" }); });
app.listen(PORT, function() { console.log("Bot andando en puerto " + PORT); });
ENDOFFILE
