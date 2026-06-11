var express = require("express");
var supabase = require("@supabase/supabase-js");
var twilio = require("twilio");
var app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// CORS para que la app (Netlify) pueda consultar este bot
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
var db = supabase.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
var twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
var historiales = {};
// Último vencimiento cargado por cada usuario (para adjuntar archivos al siguiente mensaje)
var window_ultimoVenc = {};
// Acciones pendientes de confirmación (modo "previsualizar antes de cargar")
var window_pendiente = {};

// ── DIAGNÓSTICO DE ARRANQUE ──
console.log("=== BOT v5.1 - ODOMETRO EN KM (fix metros Sitrack) ===");
console.log("Node:", process.version);
console.log("Tiene fetch global:", typeof fetch !== "undefined");
console.log("SUPABASE_URL configurado:", !!process.env.SUPABASE_URL);
console.log("SUPABASE_KEY configurado:", !!process.env.SUPABASE_KEY);
console.log("ANTHROPIC_API_KEY configurado:", !!process.env.ANTHROPIC_API_KEY);
console.log("TWILIO_ACCOUNT_SID configurado:", !!process.env.TWILIO_ACCOUNT_SID);
console.log("============================");

// Fallback: si Node es <18 no tiene fetch global, usamos node-fetch o https
var _fetch = typeof fetch !== "undefined" ? fetch : null;
if (!_fetch) {
  // Si fetch no está, usar https nativo
  var https = require("https");
  _fetch = function(url, opts) {
    return new Promise(function(resolve, reject) {
      var u = new URL(url);
      var req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: opts.headers || {}
      }, function(res) {
        var data = "";
        res.on("data", function(c) { data += c; });
        res.on("end", function() {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: function() { return Promise.resolve(data); },
            json: function() { return Promise.resolve(JSON.parse(data)); }
          });
        });
      });
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  };
  console.log("Usando https nativo (fetch no disponible)");
}

// Llamada directa a la API de Anthropic (sin depender del SDK que cambia entre versiones)
// Consulta a la API de Sitrack el último reporte de un camión (por patente)
// Devuelve {ok, data, error}
async function consultarUbicacionSitrack(patente) {
  if (!process.env.SITRACK_USER || !process.env.SITRACK_PASS) {
    return {ok:false, error:"Credenciales Sitrack no configuradas en Render (faltan SITRACK_USER o SITRACK_PASS)"};
  }
  var sUser = process.env.SITRACK_USER.trim();
  var sPass = process.env.SITRACK_PASS.trim();
  console.log("[SITRACK] user len:", sUser.length, "pass len:", sPass.length, "user:", sUser);
  var auth = "Basic " + Buffer.from(sUser+":"+sPass).toString("base64");
  var url = "https://externalappgw.ar.sitrack.com/v2/report" + (patente ? "?assetId="+encodeURIComponent(patente) : "");
  console.log("[SITRACK] Consultando:", url);
  try {
    var resp = await _fetch(url, {
      method: "GET",
      headers: { "Authorization": auth, "Accept": "application/json" }
    });
    var txt = await resp.text();
    console.log("[SITRACK] Status:", resp.status);
    console.log("[SITRACK] Respuesta:", txt.substring(0, 500));
    if (resp.status === 401 || resp.status === 403) {
      return {ok:false, error:"Credenciales rechazadas por Sitrack (HTTP "+resp.status+"). Sitrack respondio: "+txt.substring(0,150)};
    }
    if (resp.status !== 200) {
      return {ok:false, error:"Sitrack devolvió HTTP "+resp.status};
    }
    var data;
    try { data = JSON.parse(txt); } catch(e) { return {ok:false, error:"Respuesta no es JSON válido"}; }
    return {ok:true, data:data};
  } catch (e) {
    console.error("[SITRACK] Error:", e.message);
    return {ok:false, error:e.message};
  }
}

// Normaliza el odometro de Sitrack a KILOMETROS.
// Sitrack devuelve el odometro en METROS. Si el valor es gigante (mas de 2 millones,
// imposible en km para un camion) lo dividimos por 1000 para pasarlo a km de verdad.
function normalizarOdometro(val) {
  if (val === undefined || val === null) return null;
  var n = Number(val);
  if (isNaN(n)) return null;
  if (n > 2000000) n = n / 1000;
  return Math.round(n);
}

// Formatea el reporte de Sitrack a texto legible para WhatsApp
function formatearReporteSitrack(report, codigoCam, patente) {
  // La estructura puede variar - intentamos varios campos comunes
  var lat = report.lat || report.latitude || report.latitud || (report.position && report.position.lat);
  var lng = report.lng || report.lon || report.longitude || report.longitud || (report.position && report.position.lng);
  var speed = report.speed || report.velocidad || report.velocity;
  var address = report.address || report.direccion || report.location || report.formattedAddress;
  var datetime = report.datetime || report.date || report.fecha || report.timestamp || report.reportDate;
  var odometer = normalizarOdometro(report.odometer || report.odometro || report.km);
  var ignition = report.ignition || report.encendido;
  var lineas = [];
  lineas.push("📍 "+codigoCam+(patente?" ("+patente+")":""));
  if (address) lineas.push("📌 "+address);
  if (lat && lng) lineas.push("🗺️ https://maps.google.com/?q="+lat+","+lng);
  if (speed !== undefined && speed !== null) lineas.push("🚗 Velocidad: "+speed+" km/h");
  if (odometer !== undefined && odometer !== null) lineas.push("🛣️ Odómetro: "+Number(odometer).toLocaleString("es-AR")+" km");
  if (ignition !== undefined && ignition !== null) lineas.push("🔑 "+(ignition?"Encendido":"Apagado"));
  if (datetime) lineas.push("🕐 Reportó: "+datetime);
  return lineas.join("\n");
}

async function callAnthropic(systemPrompt, messages, model, maxTokens) {
  var r = await _fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens || 1500,
      system: systemPrompt,
      messages: messages
    })
  });
  if (!r.ok) {
    var errText = await r.text();
    throw new Error("Anthropic API " + r.status + ": " + errText.substring(0, 200));
  }
  return await r.json();
}

var SYSTEM_BASE = "REGLAS DE FORMATO CR\u00cdTICAS (las m\u00e1s importantes, ANTES DE TODO): 1) Devolv\u00e9 EXCLUSIVAMENTE JSON crudo (raw JSON). NUNCA NUNCA NUNCA uses bloques de c\u00f3digo markdown como triple-backtick-json o triple-backtick. 2) Tu respuesta debe empezar DIRECTAMENTE con la llave { o el corchete [. NUNCA con la palabra json ni con caracteres antes del JSON. 3) Si el usuario menciona un cami\u00f3n usando PATENTE (ej MUP998, AC427LF), NO lo uses como c\u00f3digo de cami\u00f3n. Pas\u00e1 ese mismo texto en datos.camion y el sistema lo resolver\u00e1. NUNCA inventes que existe un cami\u00f3n llamado MUP998 si no est\u00e1 en la lista de cami\u00f3nes. 4) Si recibes una patente de semi (las patentes de semi est\u00e1n con cada SR-XX en el contexto), usa registrar_venc_semi con semi=SR-XX. NUNCA llames a registrar_venc_camion con una patente de semi. Sos el asistente de La Union Car SRL. Interpretas mensajes en argentino informal. PRODUCTOS: gasoil=gas_oil_g2, premium=gas_oil_premium, super=nafta_super, infinia=infinia_diesel. ACCIONES: registrar_compra, registrar_venta, registrar_cobro, registrar_gasto, registrar_entrega, registrar_sueldo, registrar_viaje, registrar_flete, registrar_venc_camion, registrar_venc_chofer, registrar_venc_semi, registrar_semi, asignar_semi, eliminar_compra, eliminar_venta, eliminar_gasto, eliminar_entrega, eliminar_cobro, eliminar_viaje, eliminar_flete, marcar_flete_cobrado, consultar_stock, consultar_saldo, consultar_ventas_hoy, consultar_alertas, consultar_chofer, consultar_balance, consultar_vencimientos, consultar_archivo, consultar_km, ubicacion_camion, responder. ⚠️ REGLAS CR\u00cdTICAS DE N\u00daMEROS: Los precios y montos los mandas SIEMPRE como n\u00fameros enteros, NUNCA con decimales. Si el usuario dice '1800' es MIL OCHOCIENTOS, lo mandas como 1800, NO como 18. Si dice '50 mil' o '50K' lo mandas como 50000. Si dice '1.5M' o 'un millon y medio' lo mandas como 1500000. NUNCA dividas un n\u00famero por 100. Precios de combustible normales son entre 800 y 3000 por litro. Si un usuario dice un numero entre 1000 y 3000 para combustible, es ese numero exacto, NO con decimales. REGLAS DE NEGOCIO: 1) COMPRAS: por defecto siempre estado_pago pendiente. Solo marcar pagada si dice 'le pague', 'ya le pague', 'pagada', 'abonada'. 2) VENTAS: La forma_pago DEFAULT es SIEMPRE cuenta_corriente (pendiente). Si el usuario NO menciona expl\u00edcitamente 'efectivo', 'transferencia', 'me transfirio', 'me pago', 'le cobre', DEBES usar cuenta_corriente. EJEMPLOS CR\u00cdTICOS: 'vend\u00ed 100L a Sampacho a 2100' = cuenta_corriente. '20mil de gas oil a 2100 sampacho' = cuenta_corriente. 'le llev\u00e9 5000L a Cristian' = cuenta_corriente. 'vend\u00ed 100L a Sampacho en transferencia' = transferencia (cobrada). NUNCA marques una venta como cobrada por defecto. Esto es CR\u00cdTICO porque si la marcas mal, Fede pierde la deuda del cliente en su sistema. 3) GASTOS DE CAMION: si dice 'X cargo combustible', 'X cambio gomas' SIN mencionar que el chofer pago de su plata, NO asocies chofer al gasto. SOLO asocia chofer si dice 'rindio', 'pago con la plata que le di', 'rinde gastos'. 4) ENTREGAS: si le DAS plata al chofer en mano usa registrar_entrega. Categorias: adelanto_sueldo, viatico, peaje, combustible, comida, otro. 5) SUELDOS: para liquidacion mensual usa registrar_sueldo. 6) CONSULTAR CHOFER: para 'cuanto le debo a X' usa consultar_chofer. 7) ELIMINAR: si el usuario pide eliminar/borrar/anular/cancelar/sacar una operacion, usa eliminar_X seg\u00fan el tipo. Captura el dato distintivo: proveedor/cliente/chofer y monto si lo mencionan. Si solo dice 'elimina la ultima X' man\u00e1 sin datos espec\u00edficos. Si dice 'borra TODAS', 'borra las dos', 'borra ambas', 'borra las 3', man\u00e1 \"cantidad\":\"todas\" en datos. 8) VIAJES: cuando el usuario dice 'X hizo Y km', 'el camion Z recorri\u00f3 Y km', 'Luis hizo 300km', usa registrar_viaje. Por defecto tipo='venta_propia'. Si dice 'flete' o 'a terceros' usa tipo='flete_terceros'. Pasa km como n\u00famero entero. Si menciona chofer pero no camion, dejas camion vacio (el bot busca el camion asignado al chofer). 9) FLETES: cuando el usuario dice 'le hice un flete a [empresa] por $X' o 'flete a Huico por 500mil', usa registrar_flete. El cliente es la empresa contratante, monto es la tarifa que vas a cobrar. 10) MARCAR FLETE COBRADO: cuando dice 'cobré el flete a X' o 'me pagaron el flete', usa marcar_flete_cobrado. 11) CONSULTAR BALANCE: cuando dice 'como viene el mes', 'cuanto gane', 'balance', 'cuanto factuté', usa consultar_balance. 12) CONSULTAR VENCIMIENTOS: cuando dice 'que vence', 'que tengo que pagar pronto', 'que se viene', 'cheques por cobrar', usa consultar_vencimientos. La cantidad de días por defecto es 30. Si dice 'esta semana' usa cantidad=7, si dice 'este mes' usa cantidad=30. 13) ELIMINAR VIAJE/FLETE: igual que las otras eliminaciones, usa eliminar_viaje o eliminar_flete según el contexto. 21) GASTOS - QUI\u00c9N RINDI\u00d3 vs QUI\u00c9N PAG\u00d3: Regla cr\u00edtica para registrar_gasto. Si el usuario menciona un chofer junto a un cami\u00f3n (ej \"75mil repuesto cami\u00f3n Enrique\", \"compr\u00e9 cubierta cami\u00f3n de Juan 200mil\"), eso identifica el CAMI\u00d3N (el de Enrique = UC-01, el de Juan = UC-02), NO significa que el chofer haya rendido el gasto. SOLO incluir datos.chofer si el usuario dice EXPL\u00cdCITAMENTE alguna de estas palabras: \"rindi\u00f3\", \"rindio\", \"gast\u00f3\", \"gasto\" (el chofer), \"pag\u00f3 el chofer\", \"X rindi\u00f3\", \"X pag\u00f3\". Ejemplos: \"75mil repuesto cami\u00f3n de Enrique\" → datos={camion:UC-01, monto:75000, categoria:repuesto} SIN chofer. \"Enrique rindi\u00f3 75mil de repuesto\" → datos={camion:UC-01, chofer:Enrique, monto:75000, categoria:repuesto} CON chofer. Cuando hay duda, NO incluyas chofer. 23) KM POR CHOFER: Si el usuario pregunta cu\u00e1ntos km hizo un chofer (\"cu\u00e1ntos km hizo Juan hoy\", \"km de enrique esta semana\", \"km de luis ayer\", \"km de fernando este mes\"), usa accion=consultar_km. En datos: chofer=nombre/apellido del chofer, periodo=\"hoy\" / \"ayer\" / \"semana\" / \"mes\" / \"semana_pasada\". DEFAULT periodo=\"hoy\". EJEMPLOS: \"cu\u00e1ntos km hizo Juan\" → {chofer:juan, periodo:hoy}; \"km de enrique esta semana\" → {chofer:enrique, periodo:semana}; \"km de luis ayer\" → {chofer:luis, periodo:ayer}; \"km de fernando este mes\" → {chofer:fernando, periodo:mes}. 22) UBICACI\u00d3N DE CAMI\u00d3N (GPS Sitrack): Si el usuario pregunta d\u00f3nde est\u00e1, ubicaci\u00f3n, posici\u00f3n, GPS, o ad\u00f3nde anda algo o alguien relacionado a un cami\u00f3n o chofer, usa accion=ubicacion_camion. Reglas para datos: a) Si menciona el c\u00f3digo del cami\u00f3n (UC-01, UC-02, etc) pon\u00e9 datos.camion con ese c\u00f3digo. b) Si menciona el NOMBRE o apellido de un chofer (Juan, Enrique, Luis, Gustavo, Fernando, Cefferino, etc), pon\u00e9 datos.chofer con ese nombre. El sistema busca autom\u00e1ticamente qu\u00e9 cami\u00f3n tiene asignado. EJEMPLOS: \"d\u00f3nde est\u00e1 UC-01\" → {camion:\"UC-01\"}; \"d\u00f3nde est\u00e1 juan\" → {chofer:\"juan\"}; \"d\u00f3nde anda enrique\" → {chofer:\"enrique\"}; \"posici\u00f3n del cami\u00f3n de luis\" → {chofer:\"luis\"}; \"d\u00f3nde est\u00e1 el cami\u00f3n de gustavo\" → {chofer:\"gustavo\"}; \"ubicaci\u00f3n UC-03\" → {camion:\"UC-03\"}. NUNCA inventes ubicaciones, SIEMPRE usa esta acci\u00f3n. 19) FECHAS RETROACTIVAS: Para registrar ventas, compras, cobros, gastos o entregas de d\u00edas anteriores, incluí el campo \"fecha\" en datos con formato DD/MM/AAAA. HOY es [FECHA_HOY]. Convertí fechas relativas a absolutas: \"ayer\"=resta 1 d\u00eda, \"el 10 del mes pasado\"=d\u00eda 10 del mes anterior, \"el lunes pasado\"=calculá la fecha. EJEMPLO: si hoy es 22/05/2026 y el usuario dice \"el mes pasado el d\u00eda 10 cobr\u00e9 5M de Petromas en efectivo\", devolv\u00e9 {accion:registrar_cobro, datos:{cliente:Petromas, monto:5000000, tipo:efectivo, fecha:\"10/04/2026\"}}. Si no menciona fecha, NO incluyas el campo fecha (se usa hoy autom\u00e1ticamente). 20) CONSULTA DE CHOFER - REGLA ESTRICTA E INVIOLABLE: Si el usuario pide CUALQUIER dato de un chofer (info, datos, DNI, patente, cami\u00f3n, tractor, semi, cisternado, capacidad, etc), SIEMPRE y OBLIGATORIAMENTE devolv\u00e9 accion=consultar_chofer con datos.chofer=apellido o nombre, y mensaje vac\u00edo. PROHIBIDO responder con accion=responder inventando datos. NUNCA JAM\u00c1S inventes, adivines o asumas el DNI, patente, marca, modelo, cisternado, capacidad o cualquier dato del chofer/cami\u00f3n/semi. Esos datos SOLO los tiene el sistema en la base de datos v\u00eda consultar_chofer. Aunque creas saber la respuesta, USA consultar_chofer. Ejemplos que SIEMPRE van por consultar_chofer: \"pasame los datos de luis\", \"info de cefferino\", \"qu\u00e9 patente tiene el cami\u00f3n de juan\", \"datos de gustavo\", \"el dni de fernando\". 18) CONFIRMACIONES CORTAS: Si en tu turno anterior preguntaste algo como \"\u00bfQuer\u00e9s registrar la VTV del SR-04 para el 04/09/2026?\" y el usuario responde con palabras cortas afirmativas como SI, S\u00cd, Dale, Ok, Claro, Confirmo, Confirma, Confirmar, Listo, Bueno, Hac\u00e9lo - DEB\u00c9S ejecutar la acci\u00f3n que estabas proponiendo usando los datos que ya ten\u00e9s en el contexto. NUNCA pidas que repitan todo. Si el usuario responde NO, Cancel\u00e1, Negativo, Mejor no, etc, devolv\u00e9 accion=responder con mensaje pidiendo qu\u00e9 dato corregir. 16) ABREVIATURAS DE COBRO MUY IMPORTANTES: 'eft' o 'efe' = efectivo; 'ch' o 'cheque' = cheque; 'tr' o 'transferencia' = transferencia. Si el usuario escribe 'Pago 5.000.000 eft' significa cobro en efectivo de $5.000.000. Si escribe 'Pago 19.469.999 ch' significa cobro con cheque de $19.469.999. 17) COBROS MIXTOS - REGLA CR\u00cdTICA: Si un MISMO mensaje contiene VARIAS formas de pago (ej: 'Pago *59.300.000* eft *19.469.999* ch *Total: $78.769.999*'), debes devolver un ARRAY con UN registrar_cobro POR CADA forma de pago. NUNCA sumes los montos en un solo cobro. EJEMPLO: el mensaje '*MIGUEL CORRIENTES* Pago *59.300.000* eft *19.469.999* ch *Total: $78.769.999*' debe generar: [{accion:'registrar_cobro',datos:{cliente:'Miguel Corrientes',monto:59300000,tipo:'efectivo'},mensaje:''},{accion:'registrar_cobro',datos:{cliente:'Miguel Corrientes',monto:19469999,tipo:'cheque'},mensaje:''}]. La l\u00ednea 'Total' solo es verificaci\u00f3n, NO la registres como cobro adicional. 15) TRACTOR vs SEMIRREMOLQUE - MUY IMPORTANTE: Cada UC-XX es el TRACTOR (camion). El semirremolque es la cisterna que arrastra (codigo SR-XX). Tienen documentos SEPARADOS. CUANDO REGISTRES UN VENCIMIENTO: si el usuario dice expl\u00edcitamente 'del SEMI', 'del semirremolque', 'de la cisterna', 'del trailer', o si menciona tipo cisterna_adr, rta, o extintor, usa registrar_venc_semi (no registrar_venc_camion). Si dice 'del UC-01', 'del cami\u00f3n', 'del tractor' o no aclara, usa registrar_venc_camion. PARA REGISTRAR_VENC_SEMI: en datos pone 'semi' con el c\u00f3digo SR-XX. Si NO sabe el c\u00f3digo del semi pero sabe a qu\u00e9 cami\u00f3n est\u00e1 asignado (ej 'el semi del UC-01'), pasa camion='UC-01' Y semi vacio. PARA REGISTRAR_SEMI: cuando dice 'agreg\u00e1 un semi nuevo'. PARA ASIGNAR_SEMI: cuando dice 'asign\u00e1 el SR-02 al UC-03'. 14) CONSULTAR ARCHIVO: cuando dice 'mandame la VTV de UC-01', 'pasame la foto del seguro de UC-03', 'la cédula del 02', 'la foto del registro de Luis', 'fotos del camión 5', usa consultar_archivo. En 'datos' pone chofer o camion según corresponda, y categoria con el tipo de archivo si lo menciona (vtv, seguro, cedula, foto, registro, dni, art, factura, recibo, cheque, etc). TIPOS VENC CAMION (TRACTOR): vtv, seguro, habilitacion_cnrt, service, cedula. TIPOS VENC SEMI: vtv, seguro, cisterna_adr, extintor, rta, patente. TIPOS VENC CHOFER: registro_conducir, dni, seguro_art, cargas_peligrosas_cnrt, psicofisico, conduccion_defensiva, libreta_sanitaria. EJEMPLOS: 'el DNI de Juan vence el 15/05/2030' \u2192 registrar_venc_chofer con tipo=dni; 'el registro de Luis vence el 10/03/2027' \u2192 registrar_venc_chofer con tipo=registro_conducir. Para choferes usa siempre el apellido. Responde siempre JSON puro sin markdown. Si el mensaje incluye UNA sola operación, devolvé UN objeto: {\"accion\":\"...\",\"datos\":{...},\"mensaje\":\"...\"}. Si el mensaje incluye VARIAS operaciones, devolvé un ARRAY de objetos. La estructura interna de cada objeto es exactamente: {\"accion\":\"nombre\",\"datos\":{\"litros\":0,\"precio_litro\":0,\"producto\":\"\",\"cliente\":\"\",\"proveedor\":\"\",\"camion\":\"\",\"semi\":\"\",\"chofer\":\"\",\"monto\":0,\"km\":0,\"origen\":\"\",\"destino\":\"\",\"tipo\":\"\",\"categoria\":\"\",\"forma_pago\":\"\",\"estado_pago\":\"\",\"cantidad\":\"\",\"mes\":0,\"anio\":0,\"fecha_vencimiento\":\"\",\"descripcion\":\"\"},\"mensaje\":\"\"}";

// Cache de mapping camiones (se refresca cada 60 segundos para no consultar la BD en cada mensaje)
var _camionesMappingCache = null;
var _camionesMappingTs = 0;

async function getCamionesContext() {
  var ahora = Date.now();
  if (_camionesMappingCache && (ahora - _camionesMappingTs) < 60000) {
    return _camionesMappingCache;
  }
  try {
    var [r, rs] = await Promise.all([
      db.from("camiones").select("codigo,patente,activo,choferes(nombre,apellido),semirremolques(codigo,patente)").eq("activo", true).order("codigo"),
      db.from("semirremolques").select("codigo,patente,activo").eq("activo", true).order("codigo")
    ]);
    var lista = (r.data || []).map(function(c) {
      var ch = c.choferes ? (c.choferes.nombre + " " + c.choferes.apellido) : "sin chofer";
      var semi = c.semirremolques ? (" semi=" + c.semirremolques.codigo) : " semi=ninguno";
      return c.codigo + "=" + ch + semi;
    }).join(", ");
    var listaSemis = (rs.data || []).map(function(s) {
      return s.codigo + (s.patente ? " (" + s.patente + ")" : "");
    }).join(", ");
    _camionesMappingCache = "CAMIONES activos: " + (lista || "ninguno") + ". SEMIRREMOLQUES activos: " + (listaSemis || "ninguno") + ".";
    _camionesMappingTs = ahora;
    return _camionesMappingCache;
  } catch (e) {
    return "CAMIONES: consultar al usuario si hace falta.";
  }
}

async function getSystem() {
  var contexto = await getCamionesContext();
  // Fecha de hoy en formato DD/MM/AAAA para fechas retroactivas
  var d = new Date();
  var fechaHoy = String(d.getDate()).padStart(2,"0")+"/"+String(d.getMonth()+1).padStart(2,"0")+"/"+d.getFullYear();
  var sysConFecha = SYSTEM_BASE.replace("[FECHA_HOY]", fechaHoy);
  return contexto + " " + sysConFecha;
}

function hoy() { return new Date().toISOString().split("T")[0]; }

// Convertir cualquier formato común de fecha a YYYY-MM-DD (formato Postgres)
function parseFecha(s) {
  if (!s) return null;
  s = String(s).trim();
  // Ya está en formato ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Formato DD/MM/YYYY o DD-MM-YYYY o DD/MM/YY (argentino)
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    var dd = m[1].padStart(2, "0");
    var mm = m[2].padStart(2, "0");
    var yyyy = m[3].length === 2 ? "20" + m[3] : m[3];
    // Validar valores razonables
    if (parseInt(dd) > 31 || parseInt(mm) > 12) return null;
    return yyyy + "-" + mm + "-" + dd;
  }
  // Intentar con Date.parse como última opción
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

function pM(s) { if (!s) return null; var x=s.toString().replace(/[$]/g,"").replace(/[.]/g,"").replace(/,/g,".").trim(); if (x.toUpperCase().endsWith("M")) return parseFloat(x)*1000000; if (x.toUpperCase().endsWith("K")) return parseFloat(x)*1000; return parseFloat(x); }

// Fecha de la operación: si el usuario pasó una fecha (retroactiva), la usa; sino hoy
function fechaOp(datosFecha) {
  if (datosFecha) {
    var f = parseFecha(datosFecha);
    if (f) return f;
  }
  return hoy();
}
function mP(t) { if (!t) return "gas_oil_g2"; var x=t.toLowerCase(); if (x.includes("super")||x.includes("sup")) return "nafta_super"; if (x.includes("infinia")) return "infinia_diesel"; if (x.includes("premium")||x.includes("euro")) return "gas_oil_premium"; return "gas_oil_g2"; }
function fmt(n) { return "$"+Number(n).toLocaleString("es-AR"); }

async function find(tabla,campo,valor) {
  if (!valor) return null;
  var v = valor.toString().trim();
  // Para camiones y semis: si el valor parece un código (UC-XX, SR-XX), búsqueda EXACTA por codigo
  if ((tabla==="camiones" || tabla==="semirremolques") && campo==="codigo") {
    if (/^(uc|sr)-?\d+$/i.test(v)) {
      // Normalizar: "uc02" → "UC-02", "uc-2" → "UC-02"
      var m = v.match(/^(uc|sr)-?(\d+)$/i);
      var codNorm = m[1].toUpperCase() + "-" + m[2].padStart(2, "0");
      var r = await db.from(tabla).select("*").eq("codigo", codNorm).limit(1);
      if (r.data && r.data[0]) return r.data[0];
      // Si no encuentra exacto, no hagas fuzzy: devolvé null
      return null;
    }
    // Si el valor parece patente (no es UC-XX/SR-XX), buscar por patente exacta
    var rPat = await db.from(tabla).select("*").ilike("patente", v).limit(1);
    if (rPat.data && rPat.data[0]) return rPat.data[0];
    return null;
  }
  // Fallback genérico para otras tablas
  var r=await db.from(tabla).select("id,"+campo).ilike(campo,"%"+v+"%").limit(1);
  return r.data&&r.data[0]?r.data[0]:null;
}

async function findChofer(valor) {
  if (!valor) return null;
  // normalizar: lowercase + sin tildes
  var norm = function(s){ return (s||"").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim(); };
  var v = norm(valor);
  if (!v) return null;
  // buscar amplio
  var r = await db.from("choferes").select("*").or("apellido.ilike.%"+valor+"%,nombre.ilike.%"+valor+"%").limit(10);
  var lista = (r.data && r.data.length) ? r.data : [];
  // si no encontró nada, traer todos y filtrar a mano (por si hay tildes)
  if (!lista.length) {
    var todos = await db.from("choferes").select("*");
    lista = (todos.data||[]).filter(function(c){
      var n = norm(c.nombre), a = norm(c.apellido);
      return n.includes(v) || a.includes(v) || v.includes(n) || v.includes(a);
    });
  }
  if (!lista.length) return null;
  if (lista.length === 1) return lista[0];
  // si hay varios, preferir match exacto de apellido o de nombre+apellido
  for (var i=0; i<lista.length; i++) {
    var full = norm(lista[i].nombre+" "+lista[i].apellido);
    var ap = norm(lista[i].apellido);
    var nm = norm(lista[i].nombre);
    if (ap===v || full===v || nm===v) return lista[i];
  }
  return lista[0];
}

// Calcula la cuenta corriente de un chofer en un mes/año dado
async function cuentaChofer(chofer_id, mes, anio) {
  var primero=anio+"-"+String(mes).padStart(2,"0")+"-01";
  var ultimoDia=new Date(anio,mes,0).getDate();
  var ultimo=anio+"-"+String(mes).padStart(2,"0")+"-"+String(ultimoDia).padStart(2,"0");
  var [vRes,eRes,gRes]=await Promise.all([
    db.from("viajes").select("km").eq("chofer_id",chofer_id).gte("fecha",primero).lte("fecha",ultimo),
    db.from("entregas_choferes").select("monto").eq("chofer_id",chofer_id).gte("fecha",primero).lte("fecha",ultimo),
    db.from("gastos_camiones").select("monto").eq("chofer_id",chofer_id).gte("fecha",primero).lte("fecha",ultimo)
  ]);
  var km=(vRes.data||[]).reduce(function(s,v){return s+Number(v.km||0);},0);
  var viajes=(vRes.data||[]).length;
  var entregas=(eRes.data||[]).reduce(function(s,e){return s+Number(e.monto||0);},0);
  var rendido=(gRes.data||[]).reduce(function(s,g){return s+Number(g.monto||0);},0);
  return { km:km, viajes:viajes, entregas:entregas, rendido:rendido };
}

async function run(accion,datos,contextFrom) {
  try {
    if (accion==="registrar_compra") {
      var p=await find("proveedores","nombre",datos.proveedor);
      var l=pM(datos.litros);
      var pr=pM(datos.precio_litro);
      if (!l||!pr) return {ok:false,msg:"Faltan litros o precio"};
      // Validación: precio sospechoso (combustible normalmente entre 500 y 5000)
      if (pr < 100) return {ok:false,msg:"⚠️ Precio sospechoso: $"+pr+" por litro parece muy bajo. ¿Quisiste decir $"+(pr*100)+"? Volvé a mandar el mensaje aclarando el precio."};
      var estPago=datos.estado_pago==="pagada"?"pagada":"pendiente";
      var e=await db.from("compras").insert([{proveedor_id:p?p.id:null,fecha:fechaOp(datos.fecha),producto:mP(datos.producto),litros:l,precio_litro:pr,estado_pago:estPago}]);
      if (e.error) return {ok:false,msg:e.error.message};
      var totMsg=fmt(l*pr);
      var estMsg=estPago==="pagada"?" [PAGADA]":" [PENDIENTE PAGO]";
      return {ok:true,msg:"Compra OK"+estMsg+"\n"+(p?p.nombre:datos.proveedor||"?")+"\n"+l.toLocaleString("es-AR")+"L a "+fmt(pr)+"\nTotal: "+totMsg};
    }

    if (accion==="registrar_venta") {
      var c=await find("clientes","nombre",datos.cliente);
      var l=pM(datos.litros);
      var pr=pM(datos.precio_litro);
      if (!l||!pr) return {ok:false,msg:"Faltan litros o precio"};
      // Validación: precio sospechoso
      if (pr < 100) return {ok:false,msg:"⚠️ Precio sospechoso: $"+pr+" por litro parece muy bajo. ¿Quisiste decir $"+(pr*100)+"? Volvé a mandar aclarando el precio."};
      var fp=(datos.forma_pago||"").toLowerCase();
      var cobradaAlMomento=fp==="efectivo"||fp==="transferencia";
      var condPago=cobradaAlMomento?fp:"cuenta_corriente";
      var estadoCb=cobradaAlMomento?"cobrado":"pendiente";
      var totalVenta = l * pr;
      var e=await db.from("ventas").insert([{cliente_id:c?c.id:null,fecha:fechaOp(datos.fecha),producto:mP(datos.producto),litros:l,precio_litro_venta:pr,condicion_pago:condPago,estado_cobro:estadoCb}]);
      if (e.error) return {ok:false,msg:e.error.message};
      // Si la venta queda cobrada al momento (efectivo/transferencia), crear también el registro de cobranza
      // para que aparezca en la vista de Cobranzas y los totales cuadren
      if (cobradaAlMomento && c) {
        await db.from("cobranzas").insert([{
          cliente_id: c.id,
          tipo: fp,
          monto: totalVenta,
          fecha_emision: fechaOp(datos.fecha),
          estado: "cobrado",
          notas: "Auto: venta " + l + "L a $" + pr
        }]);
      }
      var estTxt=cobradaAlMomento?" [COBRADA en "+fp+"]":" [a cuenta corriente]";
      return {ok:true,msg:"Venta OK"+estTxt+"\n"+(c?c.nombre:datos.cliente||"?")+"\n"+l.toLocaleString("es-AR")+"L a "+fmt(pr)+"\nTotal: "+fmt(totalVenta)};
    }

    if (accion==="registrar_cobro") { var c=await find("clientes","nombre",datos.cliente); var m=pM(datos.monto); if (!m) return {ok:false,msg:"Falta el monto"}; var t=datos.tipo||"efectivo"; var e=await db.from("cobranzas").insert([{cliente_id:c?c.id:null,tipo:t,monto:m,fecha_emision:fechaOp(datos.fecha),estado:t==="efectivo"||t==="transferencia"?"cobrado":"pendiente"}]); if (e.error) return {ok:false,msg:e.error.message}; if (c) { await db.from("ventas").update({estado_cobro:"cobrado"}).eq("cliente_id",c.id).eq("estado_cobro","pendiente"); } return {ok:true,msg:"Cobro OK\n"+(c?c.nombre:datos.cliente||"?")+"\n"+fmt(m)+" en "+t}; }

    // GASTO CAMION (con chofer opcional si fue rendido por un chofer)
    if (accion==="registrar_gasto") {
      var cam=await find("camiones","codigo",datos.camion);
      var ch=datos.chofer?await findChofer(datos.chofer):null;
      var m=pM(datos.monto);
      if (!m) return {ok:false,msg:"Falta el monto"};
      var e=await db.from("gastos_camiones").insert([{camion_id:cam?cam.id:null,chofer_id:ch?ch.id:null,fecha:fechaOp(datos.fecha),categoria:datos.categoria||"otro",monto:m,descripcion:datos.descripcion||null,proveedor:datos.proveedor||null}]);
      if (e.error) return {ok:false,msg:e.error.message};
      var msg="Gasto OK\n"+fmt(m);
      if (cam) msg+="\nCamion: "+cam.codigo;
      if (ch) msg+="\nRindio: "+ch.nombre+" "+ch.apellido;
      if (datos.descripcion) msg+="\n"+datos.descripcion;
      return {ok:true,msg:msg};
    }

    // ENTREGA AL CHOFER (plata en mano: adelanto, viatico, etc.)
    if (accion==="registrar_entrega") {
      var ch=await findChofer(datos.chofer);
      if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer+". Usa el apellido."};
      var m=pM(datos.monto);
      if (!m) return {ok:false,msg:"Falta el monto"};
      var cat=datos.categoria||"adelanto_sueldo";
      var e=await db.from("entregas_choferes").insert([{chofer_id:ch.id,fecha:fechaOp(datos.fecha),categoria:cat,monto:m,descripcion:datos.descripcion||null}]);
      if (e.error) return {ok:false,msg:e.error.message};
      return {ok:true,msg:"Entrega OK\n"+ch.nombre+" "+ch.apellido+"\n"+fmt(m)+" ("+cat.replace(/_/g," ")+")"};
    }

    // LIQUIDACION DE SUELDO MENSUAL (calcula todo solo)
    if (accion==="registrar_sueldo") {
      var ch=await findChofer(datos.chofer);
      if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer};
      var d=new Date();
      var mes=parseInt(datos.mes)||(d.getMonth()+1);
      var anio=parseInt(datos.anio)||d.getFullYear();
      if (mes<1||mes>12) return {ok:false,msg:"Mes invalido"};
      var ya=await db.from("sueldos_choferes").select("id").eq("chofer_id",ch.id).eq("mes",mes).eq("anio",anio).maybeSingle();
      if (ya.data) return {ok:false,msg:"Ya hay liquidacion de "+ch.apellido+" para "+mes+"/"+anio};
      var cc=await cuentaChofer(ch.id,mes,anio);
      var sf=Number(ch.sueldo_fijo||0);
      var tk=Number(ch.variable_por_km||0);
      var tv=Number(ch.variable_por_viaje||0);
      var totalKm=cc.km*tk;
      var totalViajes=cc.viajes*tv;
      var bruto=sf+totalKm+totalViajes;
      var adelantos=cc.entregas-cc.rendido;
      var neto=bruto-adelantos;
      // total_bruto y total_neto NO se envian: son columnas GENERADAS por la base
      var e=await db.from("sueldos_choferes").insert([{chofer_id:ch.id,mes:mes,anio:anio,sueldo_fijo:sf,km_totales:cc.km,viajes_totales:cc.viajes,variable_km:totalKm,variable_viajes:totalViajes,total_adelantos:adelantos,estado:"pendiente"}]);
      if (e.error) return {ok:false,msg:e.error.message};
      return {ok:true,msg:"Liquidacion "+ch.apellido+" "+mes+"/"+anio+"\nFijo: "+fmt(sf)+"\nKm: "+cc.km.toLocaleString("es-AR")+" x "+fmt(tk)+" = "+fmt(totalKm)+"\nViajes: "+cc.viajes+" x "+fmt(tv)+" = "+fmt(totalViajes)+"\nBruto: "+fmt(bruto)+"\nEntregas: "+fmt(cc.entregas)+"\nRendido: "+fmt(cc.rendido)+"\nAdelantos: "+fmt(adelantos)+"\nNETO: "+fmt(neto)};
    }

    // UBICACIÓN DEL CAMIÓN VÍA SITRACK GPS
    if (accion==="ubicacion_camion") {
      var cam = null;
      // Si pasa el codigo del camion, lo usamos directo
      if (datos.camion) cam = await find("camiones","codigo",datos.camion);
      // Si pasa el chofer (por nombre o apellido), buscamos su camion asignado
      if (!cam && datos.chofer) {
        var ch = await findChofer(datos.chofer);
        if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer};
        // Buscar camion asignado a este chofer
        var rCam = await db.from("camiones").select("*").eq("chofer_id",ch.id).maybeSingle();
        if (!rCam.data) return {ok:false,msg:ch.apellido+" no tiene cami\u00f3n asignado"};
        cam = rCam.data;
      }
      if (!cam) return {ok:false,msg:"No pude identificar el cami\u00f3n. Deci 'd\u00f3nde esta UC-01' o 'd\u00f3nde esta Juan'"};
      if (!cam.patente) return {ok:false,msg:"El "+cam.codigo+" no tiene patente cargada, no puedo consultar Sitrack"};
      var rS = await consultarUbicacionSitrack(cam.patente);
      if (!rS.ok) return {ok:false,msg:"❌ "+rS.error};
      var report = rS.data;
      if (Array.isArray(report)) report = report[0];
      if (report && report.reports && Array.isArray(report.reports)) report = report.reports[0];
      if (!report) return {ok:false,msg:"Sitrack no devolvió datos para "+cam.codigo+" ("+cam.patente+")"};
      var msg = formatearReporteSitrack(report, cam.codigo, cam.patente);
      return {ok:true,msg:msg};
    }

    // CONSULTAR KM RECORRIDOS POR CHOFER (hoy, ayer, semana, mes)
    if (accion==="consultar_km") {
      var ch = await findChofer(datos.chofer || "");
      if (!ch) return {ok:false, msg:"No encontre al chofer "+(datos.chofer||"")};
      // Calcular rango de fechas según el periodo
      var hoyAR = new Date().toLocaleDateString("en-CA", {timeZone:"America/Argentina/Buenos_Aires"});
      var periodo = (datos.periodo || datos.tipo || "hoy").toLowerCase();
      var desde, hasta, label;
      var hoyDate = new Date(hoyAR + "T12:00:00");
      if (periodo === "ayer") {
        var ay = new Date(hoyDate); ay.setDate(ay.getDate()-1);
        desde = hasta = ay.toISOString().split("T")[0];
        label = "ayer ("+desde+")";
      } else if (periodo === "semana" || periodo === "esta_semana") {
        // Desde el lunes hasta hoy
        var lun = new Date(hoyDate);
        var dia = lun.getDay(); // 0=domingo, 1=lunes
        var diff = dia === 0 ? -6 : 1-dia;
        lun.setDate(lun.getDate()+diff);
        desde = lun.toISOString().split("T")[0];
        hasta = hoyAR;
        label = "esta semana (desde "+desde+")";
      } else if (periodo === "mes" || periodo === "este_mes") {
        var pri = new Date(hoyDate);
        pri.setDate(1);
        desde = pri.toISOString().split("T")[0];
        hasta = hoyAR;
        label = "este mes (desde "+desde+")";
      } else if (periodo === "semana_pasada") {
        var lun2 = new Date(hoyDate);
        var dia2 = lun2.getDay();
        var diff2 = dia2 === 0 ? -13 : -6-dia2;
        lun2.setDate(lun2.getDate()+diff2);
        desde = lun2.toISOString().split("T")[0];
        var dom = new Date(lun2); dom.setDate(dom.getDate()+6);
        hasta = dom.toISOString().split("T")[0];
        label = "la semana pasada ("+desde+" a "+hasta+")";
      } else {
        // hoy por defecto
        desde = hasta = hoyAR;
        label = "hoy ("+hoyAR+")";
      }
      var rV = await db.from("viajes").select("fecha,km,origen,destino,observaciones").eq("chofer_id",ch.id).gte("fecha",desde).lte("fecha",hasta).order("fecha");
      var viajes = rV.data || [];
      var total = viajes.reduce(function(acc,v){return acc + Number(v.km||0);}, 0);
      var msg = "📊 *Km de "+ch.apellido+", "+ch.nombre+"*\n📅 "+label+"\n\n";
      if (viajes.length === 0) {
        msg += "Sin km registrados.";
      } else {
        // Mostrar resumen por fecha si son varios dias
        if (desde === hasta) {
          viajes.forEach(function(v){
            msg += "🛣️ "+Number(v.km).toLocaleString("es-AR")+" km" + (v.origen?" "+v.origen:"") + (v.destino && v.destino !== "Auto"?" → "+v.destino:"") + "\n";
          });
        } else {
          // Agrupar por fecha
          var porFecha = {};
          viajes.forEach(function(v){
            porFecha[v.fecha] = (porFecha[v.fecha]||0) + Number(v.km||0);
          });
          Object.keys(porFecha).sort().forEach(function(f){
            msg += "📅 "+f+": "+Number(porFecha[f]).toLocaleString("es-AR")+" km\n";
          });
        }
        msg += "\n📈 *Total: "+Number(total).toLocaleString("es-AR")+" km*";
      }
      return {ok:true, msg:msg};
    }

    // CONSULTAR INFO COMPLETA DE UN CHOFER
    if (accion==="consultar_chofer") {
      var ch=await findChofer(datos.chofer);
      if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer+". Usá el apellido."};
      // Buscar el camión que maneja + su semi asignado
      var camR = await db.from("camiones").select("id,codigo,patente,marca,modelo,semirremolque_id,semirremolques(id,codigo,patente,marca,modelo,anio,capacidad_litros,cisternado,notas)").eq("chofer_id", ch.id).maybeSingle();
      var cam = camR.data;
      var semi = cam && cam.semirremolques ? cam.semirremolques : null;
      var lineas = [];
      lineas.push("👤 Chofer: "+(ch.apellido||"")+", "+(ch.nombre||""));
      if (ch.dni) lineas.push("DNI: "+ch.dni);
      if (ch.telefono) lineas.push("Tel: "+ch.telefono);
      if (ch.cuil) lineas.push("CUIL: "+ch.cuil);
      if (cam) {
        lineas.push("🚛 Tractor: "+cam.codigo+(cam.patente?" ("+cam.patente+")":""));
      } else {
        lineas.push("🚛 Tractor: sin asignar");
      }
      if (semi) {
        lineas.push("🚚 Semi: "+semi.codigo+(semi.patente?" ("+semi.patente+")":""));
        if (semi.marca || semi.modelo) lineas.push("Marca/Modelo: "+[semi.marca,semi.modelo].filter(Boolean).join(" "));
        // Cisternado: SOLO del campo dedicado (notas suele tener datos repetidos)
        var cist = semi.cisternado || semi.compartimentos || null;
        if (cist) lineas.push("Cisternado: "+cist);
        if (semi.capacidad_litros) lineas.push("Capacidad total: "+Number(semi.capacidad_litros).toLocaleString("es-AR")+" L");
      } else {
        lineas.push("🚚 Semi: sin asignar");
      }
      return {ok:true,msg:lineas.join("\n")};
    }

    if (accion==="registrar_venc_camion") {
      var cam=await find("camiones","codigo",datos.camion);
      if (!cam) return {ok:false,msg:"No encontre el camion "+datos.camion};
      var fechaParsed = parseFecha(datos.fecha_vencimiento);
      if (!fechaParsed) return {ok:false,msg:"Fecha inválida. Mandá la fecha en formato DD/MM/AAAA (ej: 14/04/2027)"};
      var tipoVenc = datos.tipo || "vtv";
      // Buscar si ya existe un vencimiento del mismo tipo (significa que es una renovación)
      var prev = await db.from("documentos_camiones").select("id,fecha_vencimiento").eq("camion_id", cam.id).eq("tipo", tipoVenc);
      var reemplazos = (prev.data || []).length;
      if (reemplazos > 0) {
        // Borrar el/los anteriores porque fue renovado
        await db.from("documentos_camiones").delete().eq("camion_id", cam.id).eq("tipo", tipoVenc);
      }
      var e = await db.from("documentos_camiones").insert([{camion_id:cam.id,tipo:tipoVenc,fecha_vencimiento:fechaParsed,notas:datos.descripcion||null}]).select();
      if (e.error) return {ok:false,msg:e.error.message};
      if (!e.data || e.data.length === 0) return {ok:false,msg:"❌ Insert falló silenciosamente en documentos_camiones"};
      var sufijo = reemplazos > 0 ? "\n♻️ Reemplazó "+reemplazos+" vencimiento"+(reemplazos>1?"s":"")+" anterior"+(reemplazos>1?"es":"") : "";
      // Guardar para adjuntar archivos si el siguiente mensaje trae uno
      window_ultimoVenc[contextFrom] = {
        entidadTipo: "camion",
        entidadId: cam.id,
        tipoDoc: tipoVenc,
        descripcion: cam.codigo + " " + tipoVenc
      };
      var sufijoArchivo = "\n📎 Podés mandarme la foto/PDF del documento si querés adjuntarlo.";
      return {ok:true,msg:"✅ Vencimiento OK\n"+cam.codigo+" - "+tipoVenc+"\nVence: "+fechaParsed+sufijo+sufijoArchivo};
    }

    if (accion==="registrar_venc_chofer") {
      var ch=await findChofer(datos.chofer);
      if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer+". Usa el apellido exacto."};
      var fechaParsed = parseFecha(datos.fecha_vencimiento);
      if (!fechaParsed) return {ok:false,msg:"Fecha inválida. Mandá la fecha en formato DD/MM/AAAA (ej: 14/04/2027)"};
      var tipoVenc = datos.tipo || "registro_conducir";
      console.log("[VENC_CHOFER] Chofer encontrado:", ch.nombre, ch.apellido, "id:", ch.id);
      console.log("[VENC_CHOFER] Tipo:", tipoVenc, "Fecha:", fechaParsed);
      // Buscar si ya existe un vencimiento del mismo tipo (renovación)
      var prev = await db.from("documentos_choferes").select("id,fecha_vencimiento").eq("chofer_id", ch.id).eq("tipo", tipoVenc);
      var reemplazos = (prev.data || []).length;
      console.log("[VENC_CHOFER] Anteriores encontrados:", reemplazos);
      if (reemplazos > 0) {
        var delRes = await db.from("documentos_choferes").delete().eq("chofer_id", ch.id).eq("tipo", tipoVenc);
        console.log("[VENC_CHOFER] Delete result:", JSON.stringify(delRes));
      }
      // Insert con .select() para forzar confirmación de que se insertó
      var e = await db.from("documentos_choferes").insert([{chofer_id:ch.id,tipo:tipoVenc,fecha_vencimiento:fechaParsed,notas:datos.descripcion||null}]).select();
      console.log("[VENC_CHOFER] Insert result:", JSON.stringify(e));
      if (e.error) {
        console.error("[VENC_CHOFER] ERROR:", e.error);
        return {ok:false,msg:"Error guardando: "+e.error.message};
      }
      // Verificar que realmente se insertó
      if (!e.data || e.data.length === 0) {
        console.error("[VENC_CHOFER] FALLO SILENCIOSO: insert no devolvió datos");
        return {ok:false,msg:"❌ El insert falló silenciosamente. Revisar logs de Render."};
      }
      console.log("[VENC_CHOFER] OK insertado con id:", e.data[0].id);
      var sufijo = reemplazos > 0 ? "\n♻️ Reemplazó "+reemplazos+" vencimiento"+(reemplazos>1?"s":"")+" anterior"+(reemplazos>1?"es":"") : "";
      window_ultimoVenc[contextFrom] = {
        entidadTipo: "chofer",
        entidadId: ch.id,
        tipoDoc: tipoVenc,
        descripcion: ch.nombre+" "+ch.apellido+" "+tipoVenc
      };
      var sufArchCh = "\n📎 Podés mandarme la foto/PDF del documento si querés adjuntarlo.";
      return {ok:true,msg:"✅ Vencimiento OK\n"+ch.nombre+" "+ch.apellido+" - "+tipoVenc+"\nVence: "+fechaParsed+sufijo+sufArchCh};
    }

    // Helper: buscar semi por código o por camión asignado
    async function findSemi(codigoSemi, codigoCamion) {
      if (codigoSemi) {
        var r = await db.from("semirremolques").select("id,codigo,patente").ilike("codigo", "%"+codigoSemi+"%").maybeSingle();
        if (r.data) return r.data;
      }
      if (codigoCamion) {
        var rc = await db.from("camiones").select("semirremolque_id,semirremolques(id,codigo,patente)").ilike("codigo", "%"+codigoCamion+"%").maybeSingle();
        if (rc.data && rc.data.semirremolques) return rc.data.semirremolques;
      }
      return null;
    }

    if (accion==="registrar_venc_semi") {
      var semi = await findSemi(datos.semi, datos.camion);
      if (!semi) return {ok:false,msg:"No encontré el semi. Pasame el código SR-XX o decime de qué camión es."};
      var fechaP = parseFecha(datos.fecha_vencimiento);
      if (!fechaP) return {ok:false,msg:"Fecha inválida. Mandá la fecha en formato DD/MM/AAAA"};
      var tipoVS = datos.tipo || "vtv";
      // Renovación: borrar anterior del mismo tipo
      var prevS = await db.from("documentos_semirremolques").select("id").eq("semirremolque_id", semi.id).eq("tipo", tipoVS);
      var reemplS = (prevS.data || []).length;
      if (reemplS > 0) {
        await db.from("documentos_semirremolques").delete().eq("semirremolque_id", semi.id).eq("tipo", tipoVS);
      }
      var eS = await db.from("documentos_semirremolques").insert([{semirremolque_id:semi.id, tipo:tipoVS, fecha_vencimiento:fechaP, notas:datos.descripcion||null}]).select();
      if (eS.error) return {ok:false,msg:eS.error.message};
      if (!eS.data || eS.data.length === 0) return {ok:false,msg:"❌ Insert falló silenciosamente en documentos_semirremolques"};
      var sufS = reemplS > 0 ? "\n♻️ Reemplazó "+reemplS+" vencimiento"+(reemplS>1?"s":"")+" anterior"+(reemplS>1?"es":"") : "";
      window_ultimoVenc[contextFrom] = {
        entidadTipo: "semi",
        entidadId: semi.id,
        tipoDoc: tipoVS,
        descripcion: semi.codigo+" "+tipoVS
      };
      var sufArchS = "\n📎 Podés mandarme la foto/PDF del documento si querés adjuntarlo.";
      return {ok:true,msg:"✅ Vencimiento OK\n🚚 "+semi.codigo+(semi.patente?" ("+semi.patente+")":"")+" - "+tipoVS+"\nVence: "+fechaP+sufS+sufArchS};
    }

    if (accion==="registrar_semi") {
      if (!datos.codigo && !datos.semi) return {ok:false,msg:"Falta el código del semi (ej: SR-01)"};
      var codigo = (datos.codigo || datos.semi).toUpperCase();
      var ex = await db.from("semirremolques").select("id").eq("codigo", codigo).maybeSingle();
      if (ex.data) return {ok:false,msg:"Ya existe un semi con código "+codigo};
      var nuevo = {
        codigo: codigo,
        patente: datos.patente || null,
        marca: datos.marca || null,
        modelo: datos.modelo || null,
        anio: datos.anio || null,
        capacidad_litros: datos.capacidad_litros || null,
        notas: datos.descripcion || null,
        activo: true
      };
      var eN = await db.from("semirremolques").insert([nuevo]).select().maybeSingle();
      if (eN.error) return {ok:false,msg:eN.error.message};
      return {ok:true,msg:"✅ Semirremolque agregado\n🚚 "+codigo+(datos.patente?"\nPatente: "+datos.patente:"")+(datos.capacidad_litros?"\nCapacidad: "+Number(datos.capacidad_litros).toLocaleString('es-AR')+" L":"")};
    }

    if (accion==="asignar_semi") {
      if (!datos.semi || !datos.camion) return {ok:false,msg:"Pasame el código del semi y del camión (ej: 'asigná el SR-02 al UC-03')"};
      var semiA = await db.from("semirremolques").select("id,codigo").ilike("codigo","%"+datos.semi+"%").maybeSingle();
      var camA = await db.from("camiones").select("id,codigo").ilike("codigo","%"+datos.camion+"%").maybeSingle();
      if (!semiA.data) return {ok:false,msg:"No encontré el semi "+datos.semi};
      if (!camA.data) return {ok:false,msg:"No encontré el camión "+datos.camion};
      // 1) Sacarle el semi a cualquier camión que lo tuviera asignado
      await db.from("camiones").update({semirremolque_id:null}).eq("semirremolque_id", semiA.data.id);
      // 2) Asignarlo al camión elegido
      var eA = await db.from("camiones").update({semirremolque_id:semiA.data.id}).eq("id", camA.data.id);
      if (eA.error) return {ok:false,msg:eA.error.message};
      return {ok:true,msg:"✅ Asignación OK\n🚚 "+semiA.data.codigo+" → 🚛 "+camA.data.codigo};
    }

    if (accion==="registrar_viaje") {
      var km = pM(datos.km || datos.monto);
      if (!km || km <= 0) return {ok:false, msg:"Faltan los kilómetros del viaje"};
      // Resolver camion: si dieron camion lo buscamos, si no intentamos por chofer
      var cam = null;
      if (datos.camion) cam = await find("camiones","codigo",datos.camion);
      var ch = null;
      if (datos.chofer) ch = await findChofer(datos.chofer);
      // Si no hay camion pero hay chofer, usar el camion asignado al chofer
      if (!cam && ch) {
        var asign = await db.from("camiones").select("id,codigo").eq("chofer_id",ch.id).eq("activo",true).limit(1).maybeSingle();
        if (asign.data) cam = asign.data;
      }
      // Si hay camion pero no hay chofer, usar el chofer asignado al camion
      if (cam && !ch) {
        var camFull = await db.from("camiones").select("chofer_id").eq("id",cam.id).maybeSingle();
        if (camFull.data && camFull.data.chofer_id) {
          var chFull = await db.from("choferes").select("id,nombre,apellido").eq("id",camFull.data.chofer_id).maybeSingle();
          if (chFull.data) ch = chFull.data;
        }
      }
      if (!cam) return {ok:false, msg:"No encontré el camión. Decime cuál (UC-01, UC-02, etc) o pasame el nombre del chofer."};
      var tipo = (datos.tipo === "flete_terceros" || datos.tipo === "flete" || (datos.tipo||"").toLowerCase().includes("flete")) ? "flete_terceros" : "venta_propia";
      var fecha = parseFecha(datos.fecha_vencimiento || datos.fecha) || hoy();
      var e = await db.from("viajes").insert([{
        camion_id: cam.id,
        chofer_id: ch ? ch.id : null,
        fecha: fecha,
        km: km,
        origen: datos.origen || "",
        destino: datos.destino || "",
        tipo: tipo,
        notas: datos.descripcion || null
      }]);
      if (e.error) return {ok:false, msg:e.error.message};
      var chTxt = ch ? "\nChofer: " + ch.apellido + (ch.nombre ? ", "+ch.nombre : "") : "";
      var rec = ch ? "\nSuma " + fmt(km * 120) + " al sueldo (si la tarifa es $120/km)" : "";
      return {ok:true, msg:"✅ Viaje registrado\nCamión: " + cam.codigo + chTxt + "\nKm: " + km.toLocaleString("es-AR") + "\nTipo: " + (tipo === "venta_propia" ? "Venta propia" : "Flete terceros") + rec};
    }

    if (accion==="registrar_flete") {
      var tarifa = pM(datos.monto || datos.tarifa);
      if (!tarifa || tarifa <= 0) return {ok:false, msg:"Falta la tarifa del flete (cuánto cobrás)"};
      var cl = datos.cliente ? await find("clientes","nombre",datos.cliente) : null;
      var cam = datos.camion ? await find("camiones","codigo",datos.camion) : null;
      var ch = datos.chofer ? await findChofer(datos.chofer) : null;
      // Si hay camion pero no chofer, intentar asignar
      if (cam && !ch) {
        var camFull = await db.from("camiones").select("chofer_id").eq("id",cam.id).maybeSingle();
        if (camFull.data && camFull.data.chofer_id) {
          var chFull = await db.from("choferes").select("id,nombre,apellido").eq("id",camFull.data.chofer_id).maybeSingle();
          if (chFull.data) ch = chFull.data;
        }
      }
      var km = pM(datos.km) || 0;
      var e = await db.from("fletes").insert([{
        cliente_id: cl ? cl.id : null,
        camion_id: cam ? cam.id : null,
        chofer_id: ch ? ch.id : null,
        fecha: hoy(),
        origen: datos.origen || "",
        destino: datos.destino || "",
        km: km,
        tarifa: tarifa,
        estado_cobro: "pendiente"
      }]);
      if (e.error) return {ok:false, msg:e.error.message};
      return {ok:true, msg:"✅ Flete registrado [PENDIENTE COBRO]\nCliente: " + (cl ? cl.nombre : datos.cliente || "?") + (cam ? "\nCamión: " + cam.codigo : "") + (km ? "\nKm: " + km : "") + "\nTarifa: " + fmt(tarifa)};
    }

    if (accion==="consultar_saldo") { var c=await find("clientes","nombre",datos.cliente); if (!c) return {ok:false,msg:"No encontre al cliente "+datos.cliente}; var v=await db.from("ventas").select("total_venta").eq("cliente_id",c.id); var cb=await db.from("cobranzas").select("monto,estado").eq("cliente_id",c.id); var tv=(v.data||[]).reduce(function(s,x){return s+Number(x.total_venta);},0); var tc=(cb.data||[]).filter(function(x){return x.estado==="cobrado"||x.estado==="depositado";}).reduce(function(s,x){return s+Number(x.monto);},0); return {ok:true,msg:"Cuenta "+c.nombre+"\nVendido: "+fmt(tv)+"\nCobrado: "+fmt(tc)+"\nSaldo: "+fmt(Math.max(0,tv-tc))+(tv-tc>0?" DEBE":" AL DIA")}; }

    // CUENTA CORRIENTE DEL CHOFER (cuanto le debo / le di / rindio este mes)
    if (accion==="consultar_chofer") {
      var ch=await findChofer(datos.chofer);
      if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer};
      var d=new Date();
      var mes=parseInt(datos.mes)||(d.getMonth()+1);
      var anio=parseInt(datos.anio)||d.getFullYear();
      var cc=await cuentaChofer(ch.id,mes,anio);
      var sf=Number(ch.sueldo_fijo||0);
      var vk=Number(ch.variable_por_km||0);
      var vv=Number(ch.variable_por_viaje||0);
      var bruto=sf+(cc.km*vk)+(cc.viajes*vv);
      var adelantos=cc.entregas-cc.rendido;
      var neto=bruto-adelantos;
      return {ok:true,msg:"Cuenta "+ch.apellido+" "+mes+"/"+anio+"\nFijo: "+fmt(sf)+"\nKm: "+cc.km.toLocaleString("es-AR")+"\nViajes: "+cc.viajes+"\nBruto: "+fmt(bruto)+"\nLe diste: "+fmt(cc.entregas)+"\nRindio: "+fmt(cc.rendido)+"\nAdelantos: "+fmt(adelantos)+"\nA COBRAR: "+fmt(neto)};
    }

    if (accion==="consultar_stock") { var r=await db.from("stock_actual").select("*"); if (!r.data||!r.data.length) return {ok:true,msg:"Sin stock aun"}; return {ok:true,msg:"Stock:\n"+r.data.map(function(s){var n=Number(s.litros_disponibles);return s.producto.replace(/_/g," ")+": "+n.toLocaleString("es-AR")+"L ["+(n<5000?"BAJO":n<15000?"MEDIO":"OK")+"]";}).join("\n")}; }

    if (accion==="consultar_ventas_hoy") { var r=await db.from("ventas").select("*,clientes(nombre)").eq("fecha",hoy()); if (!r.data||!r.data.length) return {ok:true,msg:"No hay ventas hoy"}; var total=r.data.reduce(function(s,v){return s+Number(v.total_venta);},0); return {ok:true,msg:"Ventas hoy:\n"+r.data.map(function(v){return (v.clientes?v.clientes.nombre:"?")+" "+Number(v.litros).toLocaleString("es-AR")+"L="+fmt(v.total_venta);}).join("\n")+"\nTotal: "+fmt(total)}; }

    if (accion==="consultar_alertas") { var r=await db.from("alertas_vencimientos").select("*").in("estado",["vencido","urgente"]).order("dias_restantes",{ascending:true}).limit(10); if (!r.data||!r.data.length) return {ok:true,msg:"Sin alertas. Todo OK!"}; return {ok:true,msg:"Alertas:\n"+r.data.map(function(a){return a.entidad+" "+a.documento+": "+(a.dias_restantes<0?"VENCIDO":"vence en "+a.dias_restantes+" dias");}).join("\n")}; }

    // ── CONSULTAR BALANCE DEL MES ──
    if (accion==="consultar_balance") {
      var d=new Date();
      var mes=parseInt(datos.mes)||(d.getMonth()+1);
      var anio=parseInt(datos.anio)||d.getFullYear();
      var primero=anio+"-"+String(mes).padStart(2,"0")+"-01";
      var ultimoDia=new Date(anio,mes,0).getDate();
      var ultimo=anio+"-"+String(mes).padStart(2,"0")+"-"+String(ultimoDia).padStart(2,"0");
      var [vRes,cRes,gRes,fRes,sRes] = await Promise.all([
        db.from("ventas").select("total_venta").gte("fecha",primero).lte("fecha",ultimo),
        db.from("compras").select("total").gte("fecha",primero).lte("fecha",ultimo),
        db.from("gastos_camiones").select("monto").gte("fecha",primero).lte("fecha",ultimo),
        db.from("fletes").select("tarifa").gte("fecha",primero).lte("fecha",ultimo),
        db.from("sueldos_choferes").select("total_bruto").eq("mes",mes).eq("anio",anio)
      ]);
      var tv=(vRes.data||[]).reduce(function(s,x){return s+Number(x.total_venta||0);},0);
      var tf=(fRes.data||[]).reduce(function(s,x){return s+Number(x.tarifa||0);},0);
      var tc=(cRes.data||[]).reduce(function(s,x){return s+Number(x.total||0);},0);
      var tg=(gRes.data||[]).reduce(function(s,x){return s+Number(x.monto||0);},0);
      var ts=(sRes.data||[]).reduce(function(s,x){return s+Number(x.total_bruto||0);},0);
      var ingresos=tv+tf;
      var egresos=tc+tg+ts;
      var resultado=ingresos-egresos;
      var nombreMes=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"][mes-1];
      return {ok:true,msg:"📊 BALANCE "+nombreMes+" "+anio+"\n\nINGRESOS\nVentas: "+fmt(tv)+"\nFletes: "+fmt(tf)+"\nTotal: "+fmt(ingresos)+"\n\nEGRESOS\nCompras: "+fmt(tc)+"\nGastos: "+fmt(tg)+"\nSueldos: "+fmt(ts)+"\nTotal: "+fmt(egresos)+"\n\n"+(resultado>=0?"✅ GANANCIA: ":"❌ PÉRDIDA: ")+fmt(Math.abs(resultado))};
    }

    // ── CONSULTAR VENCIMIENTOS PRÓXIMOS ──
    if (accion==="consultar_vencimientos") {
      var hoyFecha=new Date();
      var dias=parseInt(datos.cantidad)||30;
      var futuro=new Date(hoyFecha.getTime()+dias*86400000).toISOString().split("T")[0];
      var hoyStr=hoyFecha.toISOString().split("T")[0];
      var [docCam,docCh,cheques] = await Promise.all([
        db.from("documentos_camiones").select("*,camiones(codigo)").lte("fecha_vencimiento",futuro).order("fecha_vencimiento"),
        db.from("documentos_choferes").select("*,choferes(nombre,apellido)").lte("fecha_vencimiento",futuro).order("fecha_vencimiento"),
        db.from("cobranzas").select("*,clientes(nombre)").eq("tipo","cheque").eq("estado","pendiente").lte("fecha_vencimiento",futuro).order("fecha_vencimiento")
      ]);
      var lineas=[];
      (docCam.data||[]).forEach(function(d){
        var dd=Math.floor((new Date(d.fecha_vencimiento)-hoyFecha)/86400000);
        if (dd<dias+1) lineas.push("🚛 "+(d.camiones?d.camiones.codigo:"?")+" "+d.tipo.replace(/_/g," ")+": "+(dd<0?"VENCIDO hace "+Math.abs(dd)+" días":dd===0?"VENCE HOY":"en "+dd+" días"));
      });
      (docCh.data||[]).forEach(function(d){
        var dd=Math.floor((new Date(d.fecha_vencimiento)-hoyFecha)/86400000);
        if (dd<dias+1) lineas.push("👤 "+(d.choferes?d.choferes.apellido:"?")+" "+d.tipo.replace(/_/g," ")+": "+(dd<0?"VENCIDO hace "+Math.abs(dd)+" días":dd===0?"VENCE HOY":"en "+dd+" días"));
      });
      (cheques.data||[]).forEach(function(c){
        var dd=Math.floor((new Date(c.fecha_vencimiento)-hoyFecha)/86400000);
        if (dd<dias+1) lineas.push("💸 Cheque #"+(c.nro_cheque||"?")+" "+(c.clientes?c.clientes.nombre:"")+" "+fmt(c.monto)+": "+(dd<0?"VENCIDO hace "+Math.abs(dd)+" días":dd===0?"COBRAR HOY":"en "+dd+" días"));
      });
      if (!lineas.length) return {ok:true,msg:"✅ Sin vencimientos en los próximos "+dias+" días"};
      return {ok:true,msg:"📅 Vencimientos próximos ("+dias+" días):\n\n"+lineas.join("\n")};
    }

    // ── ELIMINAR VIAJE ──
    if (accion==="eliminar_viaje") {
      var q=db.from("viajes").select("*,camiones(codigo),choferes(apellido,nombre)").order("created_at",{ascending:false}).limit(20);
      if (datos.chofer) {
        var ch=await findChofer(datos.chofer);
        if (ch) q=q.eq("chofer_id",ch.id);
      }
      if (datos.camion) {
        var cam=await find("camiones","codigo",datos.camion);
        if (cam) q=q.eq("camion_id",cam.id);
      }
      var r=await q;
      var lista=r.data||[];
      // Filtrar por km si vino
      var kmFiltro=pM(datos.km);
      if (kmFiltro) lista=lista.filter(function(v){return Math.abs(Number(v.km)-kmFiltro)<10;});
      if (!lista.length) return {ok:false,msg:"No encontré viajes para eliminar"};
      var queTodas=String(datos.cantidad||"").toLowerCase();
      if (lista.length>1 && queTodas!=="todas") {
        var msg="Encontré "+lista.length+" viajes. Decime los km del viaje a borrar o decí 'borra todos':\n";
        lista.slice(0,5).forEach(function(v,i){msg+=(i+1)+") "+(v.camiones?v.camiones.codigo:"?")+" "+(v.choferes?v.choferes.apellido:"?")+" - "+v.km+"km - "+v.fecha+"\n";});
        return {ok:true,msg:msg};
      }
      if (queTodas==="todas") {
        var ids=lista.map(function(v){return v.id;});
        var del=await db.from("viajes").delete().in("id",ids);
        if (del.error) return {ok:false,msg:del.error.message};
        return {ok:true,msg:"✅ Eliminados "+lista.length+" viajes"};
      }
      var v=lista[0];
      var del=await db.from("viajes").delete().eq("id",v.id);
      if (del.error) return {ok:false,msg:del.error.message};
      return {ok:true,msg:"✅ Viaje eliminado\n"+(v.camiones?v.camiones.codigo:"?")+" "+(v.choferes?v.choferes.apellido:"")+"\n"+v.km+" km - "+v.fecha};
    }

    // ── ELIMINAR FLETE ──
    if (accion==="eliminar_flete") {
      var q=db.from("fletes").select("*,clientes(nombre),camiones(codigo)").order("created_at",{ascending:false}).limit(20);
      if (datos.cliente) {
        var cl=await find("clientes","nombre",datos.cliente);
        if (cl) q=q.eq("cliente_id",cl.id);
      }
      var r=await q;
      var lista=r.data||[];
      if (!lista.length) return {ok:false,msg:"No encontré fletes para eliminar"};
      if (lista.length>1 && String(datos.cantidad||"").toLowerCase()!=="todas") {
        var msg="Encontré "+lista.length+" fletes. Decime el monto/tarifa para borrar uno o 'borra todos':\n";
        lista.slice(0,5).forEach(function(f,i){msg+=(i+1)+") "+(f.clientes?f.clientes.nombre:"?")+" "+fmt(f.tarifa)+" - "+f.fecha+"\n";});
        return {ok:true,msg:msg};
      }
      var f=lista[0];
      var del=await db.from("fletes").delete().eq("id",f.id);
      if (del.error) return {ok:false,msg:del.error.message};
      return {ok:true,msg:"✅ Flete eliminado\n"+(f.clientes?f.clientes.nombre:"?")+"\n"+fmt(f.tarifa)};
    }

    // ── MARCAR FLETE COBRADO ──
    if (accion==="marcar_flete_cobrado") {
      var q=db.from("fletes").select("*,clientes(nombre)").eq("estado_cobro","pendiente").order("created_at",{ascending:false}).limit(20);
      if (datos.cliente) {
        var cl=await find("clientes","nombre",datos.cliente);
        if (cl) q=q.eq("cliente_id",cl.id);
      }
      var r=await q;
      var lista=r.data||[];
      if (!lista.length) return {ok:false,msg:"No encontré fletes pendientes de cobrar"};
      if (lista.length>1 && String(datos.cantidad||"").toLowerCase()!=="todos") {
        var msg="Encontré "+lista.length+" fletes pendientes. Decime cliente o tarifa, o 'cobrá todos':\n";
        lista.slice(0,5).forEach(function(f,i){msg+=(i+1)+") "+(f.clientes?f.clientes.nombre:"?")+" "+fmt(f.tarifa)+" - "+f.fecha+"\n";});
        return {ok:true,msg:msg};
      }
      if (String(datos.cantidad||"").toLowerCase()==="todos") {
        var ids=lista.map(function(f){return f.id;});
        var upd=await db.from("fletes").update({estado_cobro:"cobrado"}).in("id",ids);
        if (upd.error) return {ok:false,msg:upd.error.message};
        var totalCobrado=lista.reduce(function(s,f){return s+Number(f.tarifa||0);},0);
        return {ok:true,msg:"✅ "+lista.length+" fletes marcados cobrados\nTotal: "+fmt(totalCobrado)};
      }
      var f=lista[0];
      var upd=await db.from("fletes").update({estado_cobro:"cobrado"}).eq("id",f.id);
      if (upd.error) return {ok:false,msg:upd.error.message};
      return {ok:true,msg:"✅ Flete cobrado\n"+(f.clientes?f.clientes.nombre:"?")+"\n"+fmt(f.tarifa)};
    }

    // ── CONSULTAR ARCHIVO ── (pide al bot que mande la foto de la VTV, etc)
    if (accion==="consultar_archivo") {
      // Resolver la entidad: chofer o camion
      var entidadTipo = null, entidadId = null, entidadNombre = "";
      if (datos.chofer) {
        var ch = await findChofer(datos.chofer);
        if (!ch) return {ok:false, msg:"No encontré al chofer "+datos.chofer};
        entidadTipo = "chofer";
        entidadId = ch.id;
        entidadNombre = ch.apellido + ", " + ch.nombre;
      } else if (datos.camion) {
        var cam = await find("camiones","codigo",datos.camion);
        if (!cam) return {ok:false, msg:"No encontré el camión "+datos.camion};
        entidadTipo = "camion";
        entidadId = cam.id;
        entidadNombre = cam.codigo;
      } else {
        return {ok:false, msg:"Decime de qué camión o chofer querés el archivo (ej: 'mandame la VTV de UC-01')"};
      }
      // Buscar archivos
      var q = db.from("archivos").select("*").eq("entidad_tipo", entidadTipo).eq("entidad_id", entidadId);
      if (datos.categoria || datos.tipo) {
        var cat = (datos.categoria || datos.tipo || "").toLowerCase().replace(/ /g,"_");
        q = q.ilike("categoria", "%"+cat+"%");
      }
      var r = await q.order("fecha_carga", {ascending:false}).limit(5);
      var archivos = r.data || [];
      if (!archivos.length) {
        return {ok:false, msg:"No encontré archivos"+(datos.categoria||datos.tipo?" de "+(datos.categoria||datos.tipo):"")+" para "+entidadNombre+".\nCargalos desde la app en el detalle."};
      }
      // Retornar datos especiales para que el webhook envíe los archivos vía Twilio mediaUrl
      return {
        ok: true,
        msg: "📎 "+entidadNombre+": "+archivos.length+" archivo"+(archivos.length>1?"s":"")+(datos.categoria||datos.tipo?" de "+(datos.categoria||datos.tipo):""),
        archivos: archivos.map(function(a){ return { url: a.url_publica, nombre: a.nombre_archivo, categoria: a.categoria }; })
      };
    }

    // ELIMINAR OPERACIONES (compra, venta, gasto, entrega, cobro)
    if (accion==="eliminar_compra" || accion==="eliminar_venta" || accion==="eliminar_gasto" || accion==="eliminar_entrega" || accion==="eliminar_cobro") {
      return await eliminarOperacion(accion.replace("eliminar_",""), datos);
    }

    return {ok:true,msg:null};
  } catch(e) { return {ok:false,msg:"Error: "+e.message}; }
}

// Helper para eliminar operaciones del bot
async function eliminarOperacion(tipo, datos) {
  var cfg = {
    compra:  { tabla:"compras",          entKey:"proveedor", entCol:"proveedor_id", relTabla:"proveedores", relSelect:"id,nombre" },
    venta:   { tabla:"ventas",           entKey:"cliente",   entCol:"cliente_id",   relTabla:"clientes",    relSelect:"id,nombre" },
    gasto:   { tabla:"gastos_camiones",  entKey:"camion",    entCol:"camion_id",    relTabla:"camiones",    relSelect:"id,codigo" },
    entrega: { tabla:"entregas_choferes",entKey:"chofer",    entCol:"chofer_id",    relTabla:"choferes",    relSelect:"id,nombre,apellido" },
    cobro:   { tabla:"cobranzas",        entKey:"cliente",   entCol:"cliente_id",   relTabla:"clientes",    relSelect:"id,nombre" }
  }[tipo];
  if (!cfg) return {ok:false,msg:"Tipo no reconocido"};

  // Resolver entidad si vino en el mensaje
  var ent = null;
  var entVal = datos[cfg.entKey];
  if (entVal) {
    if (cfg.entKey === "chofer") ent = await findChofer(entVal);
    else if (cfg.entKey === "camion") ent = await find("camiones","codigo",entVal);
    else ent = await find(cfg.relTabla, "nombre", entVal);
    if (!ent) return {ok:false,msg:"No encontré "+cfg.entKey+" '"+entVal+"'. Pasame el nombre exacto."};
  }

  // Buscar últimas 20 operaciones, filtrando si tenemos entidad
  var q = db.from(cfg.tabla).select("*").order("created_at",{ascending:false}).limit(20);
  if (ent) q = q.eq(cfg.entCol, ent.id);
  var r = await q;
  var lista = (r.data || []);
  if (!lista.length) return {ok:false,msg:"No encontré operaciones para eliminar"+(ent?" de "+entVal:"")};

  // Filtrar por monto si se especificó
  var montoFiltro = datos.monto ? pM(datos.monto) : null;
  if (montoFiltro) {
    lista = lista.filter(function(op){
      var m = Number(op.total || op.monto || (Number(op.litros||0) * Number(op.precio_litro_venta||op.precio_litro||0)));
      // Tolerancia 1% para errores de redondeo
      return Math.abs(m - montoFiltro) < Math.max(1, montoFiltro * 0.01);
    });
    if (!lista.length) return {ok:false,msg:"No encontré "+tipo+" con monto "+fmt(montoFiltro)+(ent?" de "+entVal:"")};
  }

  // Si quedó UNA sola, la eliminamos
  if (lista.length === 1) {
    var op = lista[0];
    var monto = Number(op.total || op.monto || (Number(op.litros||0) * Number(op.precio_litro_venta||op.precio_litro||0)));
    var del = await db.from(cfg.tabla).delete().eq("id", op.id);
    if (del.error) return {ok:false,msg:del.error.message};
    return {ok:true,msg:"✅ Eliminada\n"+tipo.toUpperCase()+" de "+fmt(monto)+(op.fecha?"\nFecha: "+op.fecha:"")};
  }

  // Si el usuario pidió eliminar TODAS las que matchean, las borramos todas
  var queTodas = String(datos.cantidad||"").toLowerCase();
  if (queTodas === "todas" || queTodas === "ambas" || queTodas === "las dos" || queTodas === "all") {
    var ids = lista.map(function(o){return o.id;});
    var del = await db.from(cfg.tabla).delete().in("id", ids);
    if (del.error) return {ok:false,msg:del.error.message};
    var totalBorrado = lista.reduce(function(s,op){
      var m = Number(op.total || op.monto || (Number(op.litros||0) * Number(op.precio_litro_venta||op.precio_litro||0)));
      return s + m;
    }, 0);
    return {ok:true,msg:"✅ Eliminadas "+lista.length+" "+tipo+"s\nTotal: "+fmt(totalBorrado)};
  }

  // Si hay varias, listarlas para que el usuario aclare
  var msg = "Encontré "+lista.length+" "+tipo+"s. Pasame el monto exacto para borrar una específica, o decí 'borra todas' para borrar las "+lista.length+":\n";
  lista.slice(0,5).forEach(function(op,i){
    var monto = Number(op.total || op.monto || (Number(op.litros||0) * Number(op.precio_litro_venta||op.precio_litro||0)));
    msg += (i+1)+") "+fmt(monto)+" - "+(op.fecha||"")+"\n";
  });
  return {ok:true,msg:msg};
}

app.get("/",function(req,res){res.json({status:"ok"});});

// ── CRON DIARIO: AVISA VENCIMIENTOS Y COBROS POR WHATSAPP ──
// Configurar un cron externo (cron-job.org) que pegue a este endpoint cada día a las 8:00 AM
// La autenticación es por query param ?key=XXX para que no cualquiera pueda dispararlo
app.get("/cron-daily", async function(req, res) {
  var keyEsperada = process.env.CRON_KEY || "default-key-12345";
  if (req.query.key !== keyEsperada) {
    return res.status(401).json({error:"unauthorized"});
  }
  var destino = process.env.FEDE_WHATSAPP || process.env.TWILIO_WHATSAPP_TO;
  if (!destino) {
    return res.status(500).json({error:"FEDE_WHATSAPP no configurado"});
  }
  try {
    var hoyFecha = new Date();
    var hoyStr = hoyFecha.toISOString().split("T")[0];
    var en7 = new Date(hoyFecha.getTime()+7*86400000).toISOString().split("T")[0];
    var en15 = new Date(hoyFecha.getTime()+15*86400000).toISOString().split("T")[0];

    var [vencCam, vencCh, cheques, ventasPendientes] = await Promise.all([
      db.from("documentos_camiones").select("*,camiones(codigo)").lte("fecha_vencimiento", en15).order("fecha_vencimiento"),
      db.from("documentos_choferes").select("*,choferes(nombre,apellido)").lte("fecha_vencimiento", en15).order("fecha_vencimiento"),
      db.from("cobranzas").select("*,clientes(nombre)").eq("tipo","cheque").eq("estado","pendiente").lte("fecha_vencimiento", en7).order("fecha_vencimiento"),
      db.from("ventas").select("*,clientes(nombre)").eq("estado_cobro","pendiente").eq("condicion_pago","cuenta_corriente").order("fecha")
    ]);

    var alertas = [];
    var hoyEnDias = function(fecha) { return Math.floor((new Date(fecha)-hoyFecha)/86400000); };

    // Vencimientos camiones (urgentes en 15 días o menos)
    (vencCam.data||[]).forEach(function(d) {
      var dd = hoyEnDias(d.fecha_vencimiento);
      if (dd <= 15) {
        var emoji = dd < 0 ? "🔴" : (dd <= 3 ? "🟠" : "🟡");
        alertas.push(emoji + " " + (d.camiones ? d.camiones.codigo : "?") + " " + d.tipo.replace(/_/g," ") + ": " + (dd<0 ? "VENCIDO hace "+Math.abs(dd)+"d" : dd===0 ? "VENCE HOY" : dd===1 ? "vence MAÑANA" : "vence en "+dd+"d"));
      }
    });
    // Vencimientos choferes
    (vencCh.data||[]).forEach(function(d) {
      var dd = hoyEnDias(d.fecha_vencimiento);
      if (dd <= 15) {
        var emoji = dd < 0 ? "🔴" : (dd <= 3 ? "🟠" : "🟡");
        alertas.push(emoji + " " + (d.choferes ? d.choferes.apellido : "?") + " " + d.tipo.replace(/_/g," ") + ": " + (dd<0 ? "VENCIDO hace "+Math.abs(dd)+"d" : dd===0 ? "VENCE HOY" : dd===1 ? "vence MAÑANA" : "vence en "+dd+"d"));
      }
    });
    // Cheques por cobrar (próximos 7 días)
    (cheques.data||[]).forEach(function(c) {
      var dd = hoyEnDias(c.fecha_vencimiento);
      if (dd <= 7) {
        var emoji = dd < 0 ? "🔴" : (dd === 0 ? "🟢" : "🟡");
        alertas.push(emoji + " Cheque " + (c.clientes ? c.clientes.nombre : "?") + " " + fmt(c.monto) + ": " + (dd<0 ? "VENCIDO hace "+Math.abs(dd)+"d" : dd===0 ? "COBRAR HOY" : dd===1 ? "cobrar MAÑANA" : "cobrar en "+dd+"d"));
      }
    });
    // Ventas pendientes hace mucho (más de 30 días)
    var ventasViejas = (ventasPendientes.data||[]).filter(function(v) {
      var dias = hoyEnDias(v.fecha) * -1;
      return dias >= 30;
    });
    if (ventasViejas.length > 0) {
      // Agrupar por cliente y sumar
      var porCliente = {};
      ventasViejas.forEach(function(v) {
        var cli = v.clientes ? v.clientes.nombre : "?";
        if (!porCliente[cli]) porCliente[cli] = { total: 0, count: 0, masVieja: v.fecha };
        porCliente[cli].total += Number(v.total_venta||0);
        porCliente[cli].count += 1;
        if (v.fecha < porCliente[cli].masVieja) porCliente[cli].masVieja = v.fecha;
      });
      Object.keys(porCliente).forEach(function(cli) {
        var d = porCliente[cli];
        var dias = hoyEnDias(d.masVieja) * -1;
        alertas.push("💸 " + cli + " debe " + fmt(d.total) + " ("+d.count+" venta"+(d.count>1?"s":"")+", la más vieja hace "+dias+"d)");
      });
    }

    if (alertas.length === 0) {
      // Sin alertas: no mandar mensaje todos los días si todo está OK
      return res.json({ok:true, msg:"Sin alertas", count:0});
    }

    var mensaje = "📅 BUEN DÍA, FEDE\n\nTu resumen del día:\n\n" + alertas.join("\n") + "\n\n— Bot La Unión Car";
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: destino,
      body: mensaje
    });
    return res.json({ok:true, count:alertas.length, mensaje:mensaje});
  } catch(e) {
    console.error("Cron error:", e.message);
    return res.status(500).json({error:e.message});
  }
});

// Parser robusto: limpia markdown ```json```, escapes inválidos, y usa balanceo de llaves
function extraerJSON(texto) {
  if (!texto) return null;
  var t = texto.trim();
  // Limpiar TODOS los markdown code fences en cualquier posición
  t = t.replace(/```json\s*/gi, "");
  t = t.replace(/```javascript\s*/gi, "");
  t = t.replace(/```js\s*/gi, "");
  t = t.replace(/```\s*/g, "");
  t = t.trim();
  // Limpiar escape sequences inválidas (común: \$ que rompe JSON)
  t = t.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  try { return JSON.parse(t); } catch(e) {}
  // Buscar primer { o [ y balancear llaves
  var inicio = -1, tipoApertura = null;
  for (var i=0; i<t.length; i++) {
    if (t[i]==="{") { inicio=i; tipoApertura="{"; break; }
    if (t[i]==="[") { inicio=i; tipoApertura="["; break; }
  }
  if (inicio===-1) return null;
  var cierre = tipoApertura==="{" ? "}" : "]";
  var depth=0, fin=-1, enString=false, escape=false;
  for (var i=inicio; i<t.length; i++) {
    var c=t[i];
    if (escape) { escape=false; continue; }
    if (c==="\\") { escape=true; continue; }
    if (c==='"') { enString=!enString; continue; }
    if (enString) continue;
    if (c===tipoApertura) depth++;
    else if (c===cierre) { depth--; if (depth===0) { fin=i; break; } }
  }
  if (fin===-1) return null;
  try { return JSON.parse(t.substring(inicio, fin+1)); } catch(e) { return null; }
}

// FASE 4: Sincronización nocturna de odómetros desde Sitrack
// Guarda el odómetro de cada camión y crea viajes automáticos con los km recorridos
app.get("/cron/odometros", async function(req, res) {
  if (req.query.key !== process.env.CRON_KEY) {
    return res.status(401).json({ok:false, error:"Unauthorized"});
  }
  try {
    // Fecha AR (zona horaria America/Argentina/Buenos_Aires)
    var hoy = new Date().toLocaleDateString("en-CA", {timeZone:"America/Argentina/Buenos_Aires"});
    var rCam = await db.from("camiones").select("id,codigo,patente,chofer_id,choferes(id,nombre,apellido)").order("codigo");
    var camiones = rCam.data || [];
    var resumen = [];
    var totalKm = 0;
    for (var i=0; i<camiones.length; i++) {
      var c = camiones[i];
      if (!c.patente) { resumen.push({camion:c.codigo, status:"skip", motivo:"sin patente"}); continue; }
      if (i > 0) await new Promise(function(resolve){setTimeout(resolve, 800);});
      var rS = await consultarUbicacionSitrack(c.patente);
      if (!rS.ok && rS.error && rS.error.indexOf("JSON") !== -1) {
        await new Promise(function(resolve){setTimeout(resolve, 1500);});
        rS = await consultarUbicacionSitrack(c.patente);
      }
      if (!rS.ok) { resumen.push({camion:c.codigo, status:"error", motivo:rS.error}); continue; }
      var report = rS.data;
      if (Array.isArray(report)) report = report[0];
      if (report && report.reports && Array.isArray(report.reports)) report = report.reports[0];
      if (!report) { resumen.push({camion:c.codigo, status:"error", motivo:"Sin datos GPS"}); continue; }
      var odometro = normalizarOdometro(report.odometer || report.odometro || report.km);
      if (!odometro) { resumen.push({camion:c.codigo, status:"error", motivo:"Sin odómetro en respuesta"}); continue; }
      // Guardar/actualizar odómetro de hoy con lógica de tiempo real
      var rHoy = await db.from("odometros_diarios").select("*").eq("camion_id",c.id).eq("fecha",hoy).maybeSingle();
      var diff = 0;
      var motivoFinal = null;
      var statusFinal = null;
      if (rHoy.data) {
        // YA hay registro de hoy → estamos sincronizando por segunda+ vez en el día
        var odoInicial = Number(rHoy.data.odometro_inicial_dia || rHoy.data.odometro_km);
        diff = Math.max(0, Math.round(odometro - odoInicial));
        await db.from("odometros_diarios").update({
          odometro_km: odometro,
          km_recorridos: diff,
          ultima_actualizacion: new Date().toISOString()
        }).eq("id", rHoy.data.id);
        // Actualizar viaje existente o crear uno nuevo
        if (rHoy.data.viaje_id) {
          if (diff > 0) {
            await db.from("viajes").update({
              km: diff,
              observaciones: "Auto-cargado desde Sitrack. Odómetro: " + odometro + " km (inicial dia: " + odoInicial + ")"
            }).eq("id", rHoy.data.viaje_id);
          }
        } else if (diff > 0 && c.chofer_id) {
          var insV = await db.from("viajes").insert([{
            camion_id: c.id,
            chofer_id: c.chofer_id,
            fecha: hoy,
            km: diff,
            tipo: "venta_propia",
            origen: "Sitrack",
            destino: "Auto",
            observaciones: "Auto-cargado desde Sitrack. Odómetro: " + odometro + " km"
          }]).select();
          if (insV.data && insV.data[0]) {
            await db.from("odometros_diarios").update({viaje_id: insV.data[0].id}).eq("id", rHoy.data.id);
          }
        }
        statusFinal = "ok_update";
      } else {
        // PRIMERA sincro del dia → calcular inicial = ultimo cierre anterior
        var rPrev = await db.from("odometros_diarios").select("odometro_km, fecha").eq("camion_id",c.id).lt("fecha",hoy).order("fecha",{ascending:false}).limit(1).maybeSingle();
        var odoInicial2 = odometro; // por defecto, si no hay anterior
        if (rPrev.data && rPrev.data.odometro_km) {
          odoInicial2 = Number(rPrev.data.odometro_km);
          diff = Math.round(odometro - odoInicial2);
        }
        // Validaciones
        if (diff < 0) {
          resumen.push({camion:c.codigo, status:"error", motivo:"Odómetro menor que cierre anterior ("+diff+")", odometro:odometro});
          continue;
        }
        if (diff > 5000) {
          resumen.push({camion:c.codigo, status:"error", motivo:"Diff demasiado grande ("+diff+" km)", odometro:odometro});
          continue;
        }
        // Insertar registro del dia
        var insOdo = await db.from("odometros_diarios").insert([{
          camion_id: c.id,
          fecha: hoy,
          odometro_km: odometro,
          odometro_inicial_dia: odoInicial2,
          km_recorridos: diff,
          ultima_actualizacion: new Date().toISOString()
        }]).select();
        if (insOdo.error) {
          console.error("[CRON ODO] Error insert:", insOdo.error.message);
          resumen.push({camion:c.codigo, status:"error", motivo:"DB: "+insOdo.error.message});
          continue;
        }
        // Crear viaje si hubo movimiento y hay chofer
        if (diff > 0 && c.chofer_id && insOdo.data && insOdo.data[0]) {
          var insV2 = await db.from("viajes").insert([{
            camion_id: c.id,
            chofer_id: c.chofer_id,
            fecha: hoy,
            km: diff,
            tipo: "venta_propia",
            origen: "Sitrack",
            destino: "Auto",
            observaciones: "Auto-cargado desde Sitrack. Odómetro: " + odometro + " km (inicial " + odoInicial2 + ")"
          }]).select();
          if (insV2.data && insV2.data[0]) {
            await db.from("odometros_diarios").update({viaje_id: insV2.data[0].id}).eq("id", insOdo.data[0].id);
          }
          statusFinal = "ok";
        } else if (diff === 0 && rPrev.data) {
          statusFinal = "sin_movimiento";
        } else {
          statusFinal = "primera_carga";
        }
      }
      if (statusFinal === "ok" || statusFinal === "ok_update") {
        totalKm += diff;
        resumen.push({camion:c.codigo, chofer: c.choferes?c.choferes.apellido:"-", status:statusFinal, km:diff, odometro:odometro});
      } else {
        resumen.push({camion:c.codigo, status:statusFinal, odometro:odometro});
      }
    }
    var msg = "📊 *Resumen Sitrack — " + hoy + "*\n\n";
    resumen.forEach(function(r) {
      if (r.status === "ok" || r.status === "ok_update") msg += "🚛 " + r.camion + " (" + (r.chofer||"-") + "): " + r.km + " km" + (r.status==="ok_update"?" (actualizado)":"") + "\n";
      else if (r.status === "sin_movimiento") msg += "⏸️ " + r.camion + ": sin movimiento\n";
      else if (r.status === "primera_carga") msg += "🆕 " + r.camion + ": primera carga (od. " + r.odometro + ")\n";
      else if (r.status === "skip") msg += "⏭️ " + r.camion + ": " + r.motivo + "\n";
      else msg += "⚠️ " + r.camion + ": " + (r.motivo||"error") + "\n";
    });
    msg += "\n📈 *Total flota: " + totalKm + " km*";
    if (process.env.FEDE_WHATSAPP && totalKm > 0) {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: process.env.FEDE_WHATSAPP,
          body: msg
        });
      } catch(e) { console.error("[/cron/odometros] Error WhatsApp:", e.message); }
    }
    res.json({ok:true, fecha:hoy, totalKm:totalKm, resumen:resumen, mensaje:msg});
  } catch (e) {
    console.error("[/cron/odometros] Error:", e.message);
    res.status(500).json({ok:false, error:e.message});
  }
});

// Endpoint para que la app web consulte la ubicación GPS de TODOS los camiones de la flota
// Consultamos camión por camión a Sitrack usando ?assetId=PATENTE (es lo que sabemos que funciona)
app.get("/api/flota", async function(req, res) {
  try {
    var rCam = await db.from("camiones").select("id,codigo,patente,marca,modelo,chofer_id,choferes(id,nombre,apellido)").order("codigo");
    var camiones = rCam.data || [];
    // Consultar a Sitrack en paralelo, una request por camión
    var resultados = await Promise.all(camiones.map(async function(c) {
      var ubicacion = null;
      var error = null;
      if (c.patente) {
        var rS = await consultarUbicacionSitrack(c.patente);
        if (rS.ok && rS.data) {
          var r = rS.data;
          if (Array.isArray(r)) r = r[0];
          if (r && r.reports && Array.isArray(r.reports)) r = r.reports[0];
          if (r) {
            ubicacion = {
              lat: r.lat || r.latitude || r.latitud || (r.position && r.position.lat) || null,
              lng: r.lng || r.lon || r.longitude || r.longitud || (r.position && r.position.lng) || null,
              speed: (r.speed!==undefined?r.speed:(r.velocidad!==undefined?r.velocidad:(r.velocity!==undefined?r.velocity:null))),
              address: r.address || r.direccion || r.location || r.formattedAddress || null,
              datetime: r.datetime || r.date || r.fecha || r.timestamp || r.reportDate || null,
              odometer: normalizarOdometro(r.odometer!==undefined?r.odometer:(r.odometro!==undefined?r.odometro:(r.km!==undefined?r.km:null))),
              ignition: (r.ignition!==undefined?r.ignition:(r.encendido!==undefined?r.encendido:null))
            };
          }
        } else if (!rS.ok) {
          error = rS.error;
        }
      } else {
        error = "Sin patente cargada";
      }
      return {
        camion: c.codigo,
        patente: c.patente,
        marca: c.marca,
        modelo: c.modelo,
        chofer: c.choferes ? (c.choferes.apellido + ", " + c.choferes.nombre) : null,
        ubicacion: ubicacion,
        error: error
      };
    }));
    res.json({ok:true, flota:resultados, timestamp: new Date().toISOString()});
  } catch (e) {
    console.error("[/api/flota] Error:", e.message);
    res.status(500).json({ok:false, error:e.message});
  }
});

// ── SISTEMA DE CONFIRMACIÓN ANTES DE GUARDAR ────────────────────
// Lista de acciones que ESCRIBEN en la base (requieren confirmación)
var ACCIONES_ESCRITURA = ["registrar_compra","registrar_venta","registrar_cobro","registrar_gasto","registrar_entrega","registrar_sueldo","registrar_viaje","registrar_flete","registrar_venc_camion","registrar_venc_chofer","registrar_venc_semi","registrar_semi","asignar_semi","marcar_flete_cobrado","eliminar_compra","eliminar_venta","eliminar_gasto","eliminar_entrega","eliminar_cobro","eliminar_viaje","eliminar_flete"];

function esAccionEscritura(accion) {
  return ACCIONES_ESCRITURA.indexOf(accion) !== -1;
}

function fmtMonto(n) {
  if (!n && n !== 0) return "";
  return "$" + Number(n).toLocaleString("es-AR");
}

// Arma un texto humano describiendo lo que se va a hacer (antes de confirmar)
function describirOperacion(accion, datos) {
  var d = datos || {};
  switch(accion) {
    case "registrar_compra": return "🛒 *Compra* de " + (d.litros?d.litros+"L de ":"") + (d.producto||"combustible") + (d.proveedor?" a "+d.proveedor:"") + (d.monto?" por "+fmtMonto(d.monto):(d.precio_litro?" a "+fmtMonto(d.precio_litro)+"/L":"")) + (d.estado_pago==="pagada"?" (pagada)":" (pendiente)") + (d.fecha?" - fecha "+d.fecha:"");
    case "registrar_venta": return "💰 *Venta* de " + (d.litros?d.litros+"L de ":"") + (d.producto||"combustible") + (d.cliente?" a "+d.cliente:"") + (d.precio_litro?" a "+fmtMonto(d.precio_litro)+"/L":"") + (d.forma_pago?" - pago "+d.forma_pago:"") + (d.fecha?" - fecha "+d.fecha:"");
    case "registrar_cobro": return "💵 *Cobro* de " + fmtMonto(d.monto) + (d.cliente?" de "+d.cliente:"") + (d.tipo?" en "+d.tipo:"") + (d.fecha?" - fecha "+d.fecha:"");
    case "registrar_gasto": return "🔧 *Gasto* de " + fmtMonto(d.monto) + (d.categoria?" ("+d.categoria+")":"") + (d.camion?" del "+d.camion:"") + (d.chofer?" - rendido por "+d.chofer:" (sin chofer)") + (d.fecha?" - fecha "+d.fecha:"");
    case "registrar_entrega": return "💸 *Entrega* de " + fmtMonto(d.monto) + (d.chofer?" a "+d.chofer:"") + (d.categoria?" ("+d.categoria+")":"") + (d.fecha?" - fecha "+d.fecha:"");
    case "registrar_sueldo": return "👷 *Liquidación de sueldo* a " + (d.chofer||"") + " por " + fmtMonto(d.monto);
    case "registrar_viaje": return "🛣️ *Viaje* de " + (d.km||0) + " km " + (d.chofer?"de "+d.chofer:"") + (d.camion?" en "+d.camion:"") + (d.origen?" desde "+d.origen:"") + (d.destino?" hasta "+d.destino:"");
    case "registrar_flete": return "📦 *Flete* a " + (d.cliente||"") + " por " + fmtMonto(d.monto);
    case "registrar_venc_camion": return "📅 *Vencimiento* (camión) - " + (d.tipo||"VTV") + " del " + (d.camion||"") + " vence " + (d.fecha_vencimiento||"");
    case "registrar_venc_chofer": return "📅 *Vencimiento* (chofer) - " + (d.tipo||"registro") + " de " + (d.chofer||"") + " vence " + (d.fecha_vencimiento||"");
    case "registrar_venc_semi": return "📅 *Vencimiento* (semi) - " + (d.tipo||"VTV") + " del " + (d.semi||d.camion||"") + " vence " + (d.fecha_vencimiento||"");
    case "registrar_semi": return "🚛 *Nuevo semirremolque* " + (d.codigo||"") + (d.patente?" - patente "+d.patente:"");
    case "asignar_semi": return "🔗 *Asignar* semi " + (d.semi||"") + " al camión " + (d.camion||"");
    case "marcar_flete_cobrado": return "✅ *Marcar flete como cobrado* a " + (d.cliente||"");
    case "eliminar_compra": case "eliminar_venta": case "eliminar_gasto":
    case "eliminar_entrega": case "eliminar_cobro": case "eliminar_viaje":
    case "eliminar_flete": return "🗑️ *Eliminar* " + accion.replace("eliminar_","") + (d.cantidad==="todas"?" (TODAS)":"") + (d.cliente?" de "+d.cliente:"") + (d.proveedor?" de "+d.proveedor:"") + (d.chofer?" de "+d.chofer:"") + (d.monto?" por "+fmtMonto(d.monto):"");
    default: return accion + " " + JSON.stringify(d);
  }
}

// Detecta si el usuario respondió afirmativa o negativamente a una confirmación pendiente
function detectarSiNo(texto) {
  if (!texto) return null;
  var t = texto.toLowerCase().trim().replace(/[.,!?¡¿]/g,"");
  var afirm = ["si","sí","dale","ok","okey","listo","confirmo","confirma","confirmar","si dale","sip","bueno","perfecto","correcto","hacelo","hacelo dale","va","va dale","mandalo","tira","copado","cargalo","metelo","si si","si claro","claro"];
  var neg = ["no","nope","nop","ne","negativo","cancela","cancelar","mejor no","no dale","para","pará","no no","ni en pedo","esperá","esperar","corregí","corregi","esta mal","mal","incorrecto"];
  if (afirm.indexOf(t) !== -1) return "si";
  if (neg.indexOf(t) !== -1) return "no";
  return null;
}

app.post("/webhook",async function(req,res){
  var from=req.body.From;
  var body=req.body.Body?req.body.Body.trim():"";
  var numMedia = parseInt(req.body.NumMedia||"0",10);

  // === MANEJO DE ARCHIVOS RECIBIDOS POR WHATSAPP ===
  if (numMedia > 0) {
    console.log("[ARCHIVO] Recibidos "+numMedia+" archivo(s) de "+from);
    // Recuperar el último vencimiento creado por este usuario
    var ultimo = window_ultimoVenc[from];
    if (!ultimo) {
      var msgErr = "📎 Recibí "+numMedia+" archivo(s) pero no sé a qué vencimiento adjuntarlos. Primero cargá un vencimiento (ej: 'vtv del UC-04 vence 11/03/2027') y después mandame la foto/PDF en el siguiente mensaje.";
      await enviarRespuestaTwilio(from, msgErr);
      return res.status(200).send("<Response></Response>");
    }
    // Procesar cada archivo
    var subidos = 0;
    var errores = [];
    for (var i=0; i<numMedia; i++) {
      var mediaUrl = req.body["MediaUrl"+i];
      var mediaType = req.body["MediaContentType"+i] || "application/octet-stream";
      try {
        await procesarArchivoAdjunto(mediaUrl, mediaType, ultimo);
        subidos++;
      } catch(e) {
        console.error("[ARCHIVO] Error procesando archivo "+i+":", e.message);
        errores.push(e.message);
      }
    }
    var msg = subidos>0
      ? "📎 "+subidos+" archivo(s) adjuntado(s) a "+ultimo.descripcion+" ✅"
      : "❌ No pude subir los archivos: "+errores.join(", ");
    if (subidos>0 && errores.length>0) msg += "\n⚠️ "+errores.length+" fallaron";
    await enviarRespuestaTwilio(from, msg);
    return res.status(200).send("<Response></Response>");
  }

  if (!body) return res.status(200).send("<Response></Response>");
  console.log("Msg: "+body);

  // ── SISTEMA DE CONFIRMACIÓN ────────────────────────────────
  // Si hay una acción pendiente de confirmar, ver si el usuario responde SÍ/NO
  if (window_pendiente[from]) {
    var siNo = detectarSiNo(body);
    if (siNo === "si") {
      var pend = window_pendiente[from];
      window_pendiente[from] = null;
      // Ejecutar las operaciones pendientes
      var archivosAEnviar = [];
      var respuestaEjec;
      if (Array.isArray(pend)) {
        var msgs = [];
        var okCount = 0, errCount = 0;
        for (var pi=0; pi<pend.length; pi++) {
          var op = pend[pi];
          if (op && op.accion) {
            var r = await run(op.accion, op.datos || {}, from);
            if (r.ok) { okCount++; msgs.push((pi+1)+") "+(r.msg || "Listo")); }
            else { errCount++; msgs.push((pi+1)+") ❌ "+(r.msg || "Error")); }
            if (r.archivos && r.archivos.length) archivosAEnviar = archivosAEnviar.concat(r.archivos);
          }
        }
        respuestaEjec = "Procesé "+pend.length+" operaciones ("+okCount+" OK"+(errCount?", "+errCount+" con error":"")+"):\n\n" + msgs.join("\n\n");
      } else {
        var r = await run(pend.accion, pend.datos || {}, from);
        respuestaEjec = r.ok ? (r.msg || "Listo!") : (r.msg || "Error.");
        if (r.archivos && r.archivos.length) archivosAEnviar = r.archivos;
      }
      if (!historiales[from]) historiales[from]=[];
      historiales[from].push({role:"user",content:body});
      historiales[from].push({role:"assistant",content:respuestaEjec});
      try{await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:respuestaEjec});}catch(e){console.error(e.message);}
      if (archivosAEnviar && archivosAEnviar.length) {
        for (var ai=0; ai<archivosAEnviar.length && ai<10; ai++) {
          var arch = archivosAEnviar[ai];
          try {
            await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:"📎 " + (arch.categoria ? arch.categoria.replace(/_/g," ").toUpperCase() : arch.nombre),mediaUrl:[arch.url]});
            await new Promise(function(r){setTimeout(r,500);});
          } catch(e) { console.error("Error enviando archivo: " + e.message); }
        }
      }
      return res.status(200).send("<Response></Response>");
    }
    if (siNo === "no") {
      window_pendiente[from] = null;
      var msgCancel = "🚫 Cancelado. Decime de nuevo con la corrección.";
      try{await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:msgCancel});}catch(e){console.error(e.message);}
      return res.status(200).send("<Response></Response>");
    }
    // Si no es SÍ ni NO claro, cancelar la pendiente y procesar el mensaje nuevo normalmente
    window_pendiente[from] = null;
  }

  if (!historiales[from]) historiales[from]=[];
  historiales[from].push({role:"user",content:body});
  if (historiales[from].length>16) historiales[from]=historiales[from].slice(-16);
  var respuesta="Error. Intenta de nuevo.";
  try {
    var sysPrompt = await getSystem();
    var resp = await callAnthropic(sysPrompt, historiales[from]);
    var texto=resp.content[0]?resp.content[0].text:"";
    console.log("AI: "+texto);

    var parsed = extraerJSON(texto);
    if (!parsed) {
      var pareceJSON = /^\s*[\{\[]/.test(texto) || texto.includes('"accion"') || texto.includes('"mensaje":');
      if (pareceJSON) {
        console.error("[PARSER FAIL] Texto parece JSON pero no parsea:", texto.substring(0,300));
        parsed = {accion:"responder",datos:{},mensaje:"❌ Algo se rompió al procesar. Probá de nuevo con menos texto o un dato a la vez."};
      } else {
        parsed = {accion:"responder",datos:{},mensaje:texto};
      }
    }

    // ── CHEQUEAR SI ES OPERACIÓN DE ESCRITURA → PEDIR CONFIRMACIÓN ──
    var necesitaConfirmar = false;
    var previewLines = [];
    if (Array.isArray(parsed)) {
      // Si hay al menos UNA acción de escritura, confirmar todo el array
      for (var pi=0; pi<parsed.length; pi++) {
        if (parsed[pi] && esAccionEscritura(parsed[pi].accion)) {
          necesitaConfirmar = true;
          break;
        }
      }
      if (necesitaConfirmar) {
        for (var pi=0; pi<parsed.length; pi++) {
          var op = parsed[pi];
          if (op && op.accion && op.accion !== "responder") {
            previewLines.push((pi+1)+") "+describirOperacion(op.accion, op.datos));
          }
        }
      }
    } else if (parsed.accion && esAccionEscritura(parsed.accion)) {
      necesitaConfirmar = true;
      previewLines.push(describirOperacion(parsed.accion, parsed.datos));
    }

    if (necesitaConfirmar) {
      window_pendiente[from] = parsed;
      respuesta = "🔎 Te voy a cargar lo siguiente:\n\n" + previewLines.join("\n") + "\n\n¿Lo confirmás? (SÍ / NO)";
      historiales[from].push({role:"assistant",content:respuesta});
      try{await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:respuesta});}catch(e){console.error(e.message);}
      return res.status(200).send("<Response></Response>");
    }

    // Si el modelo devolvió un ARRAY, ejecutar cada operación y armar resumen
    var archivosAEnviar = [];
    if (Array.isArray(parsed)) {
      var msgs = [];
      var okCount = 0, errCount = 0;
      for (var i=0; i<parsed.length; i++) {
        var op = parsed[i];
        if (op && op.accion && op.accion !== "responder") {
          var r = await run(op.accion, op.datos || {}, from);
          if (r.ok) { okCount++; msgs.push((i+1)+") "+(r.msg || op.mensaje || "Listo")); }
          else { errCount++; msgs.push((i+1)+") ❌ "+(r.msg || "Error")); }
          if (r.archivos && r.archivos.length) archivosAEnviar = archivosAEnviar.concat(r.archivos);
        } else if (op && op.mensaje) {
          msgs.push((i+1)+") "+op.mensaje);
        }
      }
      var header = "Procesé "+parsed.length+" operaciones ("+okCount+" OK"+(errCount?", "+errCount+" con error":"")+"):\n\n";
      respuesta = header + msgs.join("\n\n");
    }
    else if (parsed.accion && parsed.accion !== "responder") {
      var r = await run(parsed.accion, parsed.datos || {}, from);
      respuesta = r.ok ? (r.msg || parsed.mensaje || "Listo!") : (r.msg || "Error.");
      if (r.archivos && r.archivos.length) archivosAEnviar = r.archivos;
    }
    else { respuesta = parsed.mensaje || texto; }

    historiales[from].push({role:"assistant",content:respuesta});
  } catch(e){
    console.error("ERROR procesando mensaje:", e.message);
    console.error("Stack:", e.stack);
    respuesta = "❌ Error procesando tu mensaje. " + (e.message ? e.message.substring(0,80) : "Probá de nuevo.");
  }
  // Enviar respuesta de texto
  try{await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:respuesta});}catch(e){console.error(e.message);}
  // Si hay archivos para enviar, mandar uno por uno como mensajes separados con mediaUrl
  if (archivosAEnviar && archivosAEnviar.length) {
    for (var ai=0; ai<archivosAEnviar.length && ai<10; ai++) {
      var arch = archivosAEnviar[ai];
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: from,
          body: "📎 " + (arch.categoria ? arch.categoria.replace(/_/g," ").toUpperCase() : arch.nombre),
          mediaUrl: [arch.url]
        });
        // Pequeña pausa para no saturar Twilio
        await new Promise(function(r){setTimeout(r, 500);});
      } catch(e) { console.error("Error enviando archivo: " + e.message); }
    }
  }
  res.status(200).send("<Response></Response>");
});

var PORT=process.env.PORT||3000;

// === FUNCIONES PARA RECIBIR ARCHIVOS POR WHATSAPP ===

// Descarga el archivo desde la URL de Twilio (con auth basic)
function descargarArchivoTwilio(url) {
  return new Promise(function(resolve, reject) {
    var auth = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID+":"+process.env.TWILIO_AUTH_TOKEN).toString("base64");
    var doRequest = function(reqUrl) {
      var u = new URL(reqUrl);
      var protocol = u.protocol === "https:" ? require("https") : require("http");
      protocol.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {"Authorization": auth}
      }, function(res) {
        // Manejar redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error("HTTP "+res.statusCode));
        }
        var chunks = [];
        res.on("data", function(c) { chunks.push(c); });
        res.on("end", function() { resolve(Buffer.concat(chunks)); });
      }).on("error", reject);
    };
    doRequest(url);
  });
}

// Procesa un archivo adjunto: lo descarga, sube a Supabase Storage y crea registro
async function procesarArchivoAdjunto(mediaUrl, mediaType, ultimoVenc) {
  // 1) Descargar de Twilio
  var fileBuffer = await descargarArchivoTwilio(mediaUrl);
  // 2) Determinar extensión por mimetype
  var ext = "bin";
  if (mediaType.includes("jpeg") || mediaType.includes("jpg")) ext = "jpg";
  else if (mediaType.includes("png")) ext = "png";
  else if (mediaType.includes("pdf")) ext = "pdf";
  else if (mediaType.includes("webp")) ext = "webp";
  else if (mediaType.includes("heic")) ext = "heic";
  // 3) Path en storage
  var timestamp = Date.now();
  var random = Math.random().toString(36).substring(2,8);
  var nombreArchivo = ultimoVenc.tipoDoc + "_" + timestamp + "_" + random + "." + ext;
  var storagePath = ultimoVenc.entidadTipo + "/" + ultimoVenc.entidadId + "/" + nombreArchivo;
  // 4) Subir a Supabase Storage
  var up = await db.storage.from("documentos").upload(storagePath, fileBuffer, {
    contentType: mediaType,
    upsert: false
  });
  if (up.error) throw new Error("Storage: "+up.error.message);
  // 5) Obtener URL pública
  var pubUrl = db.storage.from("documentos").getPublicUrl(storagePath);
  var publicUrl = pubUrl.data ? pubUrl.data.publicUrl : null;
  // 6) Insertar en tabla archivos
  var ins = await db.from("archivos").insert([{
    entidad_tipo: ultimoVenc.entidadTipo,
    entidad_id: ultimoVenc.entidadId,
    categoria: ultimoVenc.tipoDoc,
    nombre: nombreArchivo,
    url: publicUrl,
    storage_path: storagePath,
    mime_type: mediaType,
    tamano_bytes: fileBuffer.length,
    descripcion: "Recibido por WhatsApp - " + ultimoVenc.descripcion
  }]).select();
  if (ins.error) throw new Error("DB: "+ins.error.message);
  console.log("[ARCHIVO] Subido OK:", storagePath);
  return ins.data[0];
}

// Envía un mensaje libre por WhatsApp
async function enviarRespuestaTwilio(to, mensaje) {
  try {
    await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: mensaje
    });
  } catch(e) {
    console.error("Error enviando msg:", e.message);
  }
}

app.listen(PORT,function(){console.log("Bot andando en puerto "+PORT);});
