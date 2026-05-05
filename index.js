var express = require("express");
var supabase = require("@supabase/supabase-js");
var Anthropic = require("@anthropic-ai/sdk");
var twilio = require("twilio");
var app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
var db = supabase.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
var ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
var twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
var historiales = {};
app.get("/", function(req, res) { res.json({ status: "ok", app: "La Union Car Bot" }); });
app.post("/webhook", async function(req, res) {
  var from = req.body.From;
  var body = req.body.Body ? req.body.Body.trim() : "";
  if (!body) return res.status(200).send("<Response></Response>");
  console.log("Mensaje de " + from + ": " + body);
  if (!historiales[from]) historiales[from] = [];
  historiales[from].push({ role: "user", content: body });
  if (historiales[from].length > 16) historiales[from] = historiales[from].slice(-16);
  var respuesta = "No pude procesar el mensaje.";
  try {
    var response = await ai.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 800, system: "Sos el asistente de La Union Car SRL. Responde en español argentino informal. Registras ventas, compras, cobros y gastos. Por ahora responde que el bot esta funcionando y que pronto podras registrar operaciones.", messages: historiales[from] });
    respuesta = response.content[0] ? response.content[0].text : "Sin respuesta";
    historiales[from].push({ role: "assistant", content: respuesta });
  } catch(e) { console.error(e); respuesta = "Error: " + e.message; }
  try { await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: from, body: respuesta }); } catch(e) { console.error(e); }
  res.status(200).send("<Response></Response>");
});
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Bot andando en puerto " + PORT); });
