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

var SYSTEM = "Sos el asistente de La Union Car SRL. Registras ventas, compras, cobros, gastos y vencimientos. Responde JSON: {accion:string,datos:{},mensaje:string}";
VENCIMIENTOS DE CAMIONES - registrar_venc_camion:
- 'VTV del UC-01 vence el 15/08/2026' => registrar_venc_camion, camion:UC-01, tipo:vtv, fecha_vencimiento:2026-08-15
- 'seguro del UC-03 vence en enero 2027' => registrar_venc_camion, camion:UC-03, tipo:seguro, fecha_vencimiento:2027-01-01
- Tipos camion: vtv, seguro, habilitacion_cnrt, extintor, cisterna_adr, service

VENCIMIENTOS DE CHOFERES - registrar_venc_chofer:
- 'registro de Enrique vence el 20/09/2026' => registrar_venc_chofer, chofer:Enrique, tipo:registro_conducir, fecha_vencimiento:2026-09-20
- 'psicofisico de Fernando vence en marzo 2027' => registrar_venc_chofer, chofer:Fernando, tipo:psicofisico, fecha_vencimiento:2027-03-01
- Tipos chofer: registro_conducir, seguro_art, cargas_peligrosas_cnrt, psicofisico, conduccion_defensiva, libreta_sanitaria

Para fechas siempre usar formato YYYY-MM-DD.";

function hoy() { return new Date().toISOString().split("T")[0]; }

function parseMonto(str) {
  if (!str) return null;
  var s = str.toString().replace(/\$/g, "").replace(/\./g, "").replace(/,/g, ".").trim();
  if (s.toUpperCase().endsWith("M")) return parseFloat(s) * 1000000;
  if (s.toUpperCase().endsWith("K")) return parseFloat(s) * 1000;
  return parseFloat(s);
}

function mapProducto(t) {
  if (!t) return "gas_oil_g2";
  var x = t.toLowerCase();
  if (x.includes("super") || x.includes("sup") || x.includes("nafta")) return "nafta_super";
  if (x.includes("infinia")) return "infinia_diesel";
  if (x.includes("premium") || x.includes("prem") || x.includes("euro")) return "gas_oil_premium";
  return "gas_oil_g2";
}

function fmt(n) { return "$" + Number(n).toLocaleString("es-AR"); }

async function buscar(tabla, campo, valor) {
  if (!valor) return null;
  var r = await db.from(tabla).select("id," + campo).ilike(campo, "%" + valor + "%").limit(1);
  return r.data && r.data[0] ? r.data[0] : null;
}

async function ejecutar(accion, datos) {
  try {
    if (accion === "registrar_compra") {
      var prov = await buscar("proveedores", "nombre", datos.proveedor);
      var cam = await buscar("camiones", "codigo", datos.camion);
      var l = parseMonto(datos.litros);
      var p = parseMonto(datos.precio_litro);
      if (!l || !p) return { ok: false, msg: "Faltan litros o precio. Decime cuantos litros y a que precio." };
      var e = await db.from("compras").insert([{ proveedor_id: prov ? prov.id : null, fecha: hoy(), producto: mapProducto(datos.producto), litros: l, precio_litro: p, estado_pago: "pagada" }]);
      if (e.error) return { ok: false, msg: e.error.message };
      return { ok: true, msg: "Compra registrada\nProveedor: " + (prov ? prov.nombre : datos.proveedor || "?") + "\nLitros: " + l.toLocaleString("es-AR") + "\nPrecio: " + fmt(p) + "/L\nTotal: " + fmt(l * p) };
    }
    if (accion === "registrar_venta") {
      var cli = await buscar("clientes", "nombre", datos.cliente);
      var cam = await buscar("camiones", "codigo", datos.camion);
      var l = parseMonto(datos.litros);
      var p = parseMonto(datos.precio_litro);
      if (!l || !p) return { ok: false, msg: "Faltan litros o precio. Decime cuantos litros y a que precio." };
      var e = await db.from("ventas").insert([{ cliente_id: cli ? cli.id : null, fecha: hoy(), producto: mapProducto(datos.producto), litros: l, precio_litro_venta: p, condicion_pago: datos.forma_pago || "cuenta_corriente", estado_cobro: datos.forma_pago === "efectivo" ? "cobrado" : "pendiente" }]);
      if (e.error) return { ok: false, msg: e.error.message };
      return { ok: true, msg: "Venta registrada\nCliente: " + (cli ? cli.nombre : datos.cliente || "?") + "\nLitros: " + l.toLocaleString("es-AR") + "\nPrecio: " + fmt(p) + "/L\nTotal: " + fmt(l * p) };
    }
    if (accion === "registrar_cobro") {
      var cli = await buscar("clientes", "nombre", datos.cliente);
      var m = parseMonto(datos.monto);
      if (!m) return { ok: false, msg: "Falta el monto. Cuanto cobro?" };
      var tipo = datos.tipo || "efectivo";
      var e = await db.from("cobranzas").insert([{ cliente_id: cli ? cli.id : null, tipo: tipo, monto: m, fecha_emision: hoy(), estado: tipo === "efectivo" || tipo === "transferencia" ? "cobrado" : "pendiente" }]);
      if (e.error) return { ok: false, msg: e.error.message };
      return { ok: true, msg: "Cobro registrado\nCliente: " + (cli ? cli.nombre : datos.cliente || "?") + "\nMonto: " + fmt(m) + "\nTipo: " + tipo };
    }
    if (accion === "registrar_gasto") {
      var cam = await buscar("camiones", "codigo", datos.camion);
      var m = parseMonto(datos.monto);
      if (!m) return { ok: false, msg: "Falta el monto." };
      var e = await db.from("gastos_camiones").insert([{ fecha: hoy(), categoria: datos.categoria || "otro", monto: m, descripcion: datos.descripcion || null, proveedor: datos.proveedor || null }]);
      if (e.error) return { ok: false, msg: e.error.message };
      return { ok: true, msg: "Gasto registrado\nMonto: " + fmt(m) + (datos.proveedor ? "\nA: " + datos.proveedor : "") };
    }
    if (accion === "consultar_saldo") {
      var cli = await buscar("clientes", "nombre", datos.cliente);
      if (!cli) return { ok: false, msg: "No encontre al cliente " + (datos.cliente || "?") };
      var v = await db.from("ventas").select("total_venta").eq("cliente_id", cli.id);
      var c = await db.from("cobranzas").select("monto,estado").eq("cliente_id", cli.id);
      var tv = (v.data || []).reduce(function(s, x) { return s + Number(x.total_venta); }, 0);
      var tc = (c.data || []).filter(function(x) { return x.estado === "cobrado" || x.estado === "depositado"; }).reduce(function(s, x) { return s + Number(x.monto); }, 0);
      var pend = tv - tc;
      return { ok: true, msg: "Cuenta " + cli.nombre + "\nVendido: " + fmt(tv) + "\nCobrado: " + fmt(tc) + "\nSaldo: " + fmt(Math.max(0, pend)) + (pend > 0 ? " DEBE" : " AL DIA") };
    }
    if (accion === "consultar_stock") {
      var r = await db.from("stock_actual").select("*");
      if (!r.data || !r.data.length) return { ok: true, msg: "Sin datos de stock aun. Registra compras y ventas primero." };
      var lineas = r.data.map(function(s) { var n = Number(s.litros_disponibles); return s.producto.replace(/_/g, " ") + ": " + n.toLocaleString("es-AR") + " L [" + (n < 5000 ? "BAJO" : n < 15000 ? "MEDIO" : "OK") + "]"; });
      return { ok: true, msg: "Stock actual:\n" + lineas.join("\n") };
    }
    if (accion === "consultar_ventas_hoy") {
      var r = await db.from("ventas").select("*,clientes(nombre)").eq("fecha", hoy());
      if (!r.data || !r.data.length) return { ok: true, msg: "No hay ventas registradas hoy." };
      var total = r.data.reduce(function(s, v) { return s + Number(v.total_venta); }, 0);
      var lineas = r.data.map(function(v) { return (v.clientes ? v.clientes.nombre : "?") + ": " + Number(v.litros).toLocaleString("es-AR") + "L = " + fmt(v.total_venta); });
      return { ok: true, msg: "Ventas de hoy:\n" + lineas.join("\n") + "\n\nTotal: " + fmt(total) };
    }
    if (accion === "consultar_alertas") {
      var r = await db.from("alertas_vencimientos").select("*").in("estado", ["vencido", "urgente"]).order("dias_restantes", { ascending: true }).limit(10);
      if (!r.data || !r.data.length) return { ok: true, msg: "Sin vencimientos urgentes. Todo en orden!" };
      var lineas = r.data.map(function(a) { return a.entidad + " - " + a.documento + ": " + (a.dias_restantes < 0 ? "VENCIDO hace " + Math.abs(a.dias_restantes) + " dias" : "vence en " + a.dias_restantes + " dias"); });
      return { ok: true, msg: "Alertas:\n" + lineas.join("\n") };
    }
    if (accion === "registrar_venc_camion") {
      var cam = await buscar("camiones", "codigo", datos.camion);
      if (!cam) return { ok: false, msg: "No encontre el camion " + (datos.camion || "?") + ". Usa UC-01, UC-02, etc." };
      if (!datos.fecha_vencimiento) return { ok: false, msg: "Falta la fecha de vencimiento." };
      if (!datos.tipo) return { ok: false, msg: "Falta el tipo de documento (vtv, seguro, extintor, etc.)." };
      var e = await db.from("documentos_camiones").insert([{
        camion_id: cam.id,
        tipo: datos.tipo,
        fecha_vencimiento: datos.fecha_vencimiento,
        fecha_emision: datos.fecha_emision || null,
        notas: datos.descripcion || null
      }]);
      if (e.error) return { ok: false, msg: e.error.message };
      return { ok: true, msg: "Vencimiento registrado\nCamion: " + cam.codigo + "\nDocumento: " + datos.tipo + "\nVencimiento: " + datos.fecha_vencimiento };
    }
    if (accion === "registrar_venc_chofer") {
      var chof = await buscar("choferes", "apellido", datos.chofer);
      if (!chof) chof = await buscar("choferes", "nombre", datos.chofer);
      if (!chof) return { ok: false, msg: "No encontre al chofer " + (datos.chofer || "?") };
      if (!datos.fecha_vencimiento) return { ok: false, msg: "Falta la fecha de vencimiento." };
      if (!datos.tipo) return { ok: false, msg: "Falta el tipo de documento." };
      var e = await db.from("documentos_choferes").insert([{
        chofer_id: chof.id,
        tipo: datos.tipo,
        fecha_vencimiento: datos.fecha_vencimiento,
        fecha_emision: datos.fecha_emision || null,
        notas: datos.descripcion || null
      }]);
      if (e.error) return { ok: false, msg: e.error.message };
      return { ok: true, msg: "Vencimiento registrado\nChofer: " + chof.apellido + "\nDocumento: " + datos.tipo + "\nVencimiento: " + datos.fecha_vencimiento };
    }
    return { ok: true, msg: null };
  } catch (e) {
    console.error("Error:", e);
    return { ok: false, msg: "Error: " + e.message };
  }
}

app.get("/", function(req, res) { res.json({ status: "ok" }); });

app.post("/webhook", async function(req, res) {
  var from = req.body.From;
  var body = req.body.Body ? req.body.Body.trim() : "";
  if (!body) return res.status(200).send("<Response></Response>");
  console.log("Msg: " + body);
  if (!historiales[from]) historiales[from] = [];
  historiales[from].push({ role: "user", content: body });
  if (historiales[from].length > 16) historiales[from] = historiales[from].slice(-16);
  var respuesta = "Error procesando. Intenta de nuevo.";
  try {
    var response = await ai.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 800, system: SYSTEM, messages: historiales[from] });
    var texto = response.content[0] ? response.content[0].text : "";
    console.log("Claude: " + texto);
    var parsed;
    try { parsed = JSON.parse(texto.replace(/```json/g, "").replace(/```/g, "").trim()); } catch (e) { parsed = { accion: "responder", datos: {}, mensaje: texto }; }
    if (parsed.accion && parsed.accion !== "responder") {
      var resultado = await ejecutar(parsed.accion, parsed.datos || {});
      respuesta = resultado.ok ? (resultado.msg || parsed.mensaje || "Listo!") : (resultado.msg || "Error.");
    } else {
      respuesta = parsed.mensaje || texto;
    }
    historiales[from].push({ role: "assistant", content: respuesta });
  } catch (e) {
    console.error("Error:", e.message);
    respuesta = "Error: " + e.message;
  }
  try { await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: from, body: respuesta }); } catch (e) { console.error("Twilio error:", e.message); }
  res.status(200).send("<Response></Response>");
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Bot andando en puerto " + PORT); });
