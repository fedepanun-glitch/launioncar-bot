var express = require("express");
var supabase = require("@supabase/supabase-js");
var twilio = require("twilio");
var app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
var db = supabase.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
var twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
var historiales = {};

// ── DIAGNÓSTICO DE ARRANQUE ──
console.log("=== BOT v3.0 - INICIANDO ===");
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

var SYSTEM_BASE = "Sos el asistente de La Union Car SRL. Interpretas mensajes en argentino informal. PRODUCTOS: gasoil=gas_oil_g2, premium=gas_oil_premium, super=nafta_super, infinia=infinia_diesel. ACCIONES: registrar_compra, registrar_venta, registrar_cobro, registrar_gasto, registrar_entrega, registrar_sueldo, registrar_viaje, registrar_flete, registrar_venc_camion, registrar_venc_chofer, registrar_venc_semi, registrar_semi, asignar_semi, eliminar_compra, eliminar_venta, eliminar_gasto, eliminar_entrega, eliminar_cobro, eliminar_viaje, eliminar_flete, marcar_flete_cobrado, consultar_stock, consultar_saldo, consultar_ventas_hoy, consultar_alertas, consultar_chofer, consultar_balance, consultar_vencimientos, consultar_archivo, responder. ⚠️ REGLAS CR\u00cdTICAS DE N\u00daMEROS: Los precios y montos los mandas SIEMPRE como n\u00fameros enteros, NUNCA con decimales. Si el usuario dice '1800' es MIL OCHOCIENTOS, lo mandas como 1800, NO como 18. Si dice '50 mil' o '50K' lo mandas como 50000. Si dice '1.5M' o 'un millon y medio' lo mandas como 1500000. NUNCA dividas un n\u00famero por 100. Precios de combustible normales son entre 800 y 3000 por litro. Si un usuario dice un numero entre 1000 y 3000 para combustible, es ese numero exacto, NO con decimales. REGLAS DE NEGOCIO: 1) COMPRAS: por defecto siempre estado_pago pendiente. Solo marcar pagada si dice 'le pague', 'ya le pague', 'pagada', 'abonada'. 2) VENTAS: La forma_pago DEFAULT es SIEMPRE cuenta_corriente (pendiente). Si el usuario NO menciona expl\u00edcitamente 'efectivo', 'transferencia', 'me transfirio', 'me pago', 'le cobre', DEBES usar cuenta_corriente. EJEMPLOS CR\u00cdTICOS: 'vend\u00ed 100L a Sampacho a 2100' = cuenta_corriente. '20mil de gas oil a 2100 sampacho' = cuenta_corriente. 'le llev\u00e9 5000L a Cristian' = cuenta_corriente. 'vend\u00ed 100L a Sampacho en transferencia' = transferencia (cobrada). NUNCA marques una venta como cobrada por defecto. Esto es CR\u00cdTICO porque si la marcas mal, Fede pierde la deuda del cliente en su sistema. 3) GASTOS DE CAMION: si dice 'X cargo combustible', 'X cambio gomas' SIN mencionar que el chofer pago de su plata, NO asocies chofer al gasto. SOLO asocia chofer si dice 'rindio', 'pago con la plata que le di', 'rinde gastos'. 4) ENTREGAS: si le DAS plata al chofer en mano usa registrar_entrega. Categorias: adelanto_sueldo, viatico, peaje, combustible, comida, otro. 5) SUELDOS: para liquidacion mensual usa registrar_sueldo. 6) CONSULTAR CHOFER: para 'cuanto le debo a X' usa consultar_chofer. 7) ELIMINAR: si el usuario pide eliminar/borrar/anular/cancelar/sacar una operacion, usa eliminar_X seg\u00fan el tipo. Captura el dato distintivo: proveedor/cliente/chofer y monto si lo mencionan. Si solo dice 'elimina la ultima X' man\u00e1 sin datos espec\u00edficos. Si dice 'borra TODAS', 'borra las dos', 'borra ambas', 'borra las 3', man\u00e1 \"cantidad\":\"todas\" en datos. 8) VIAJES: cuando el usuario dice 'X hizo Y km', 'el camion Z recorri\u00f3 Y km', 'Luis hizo 300km', usa registrar_viaje. Por defecto tipo='venta_propia'. Si dice 'flete' o 'a terceros' usa tipo='flete_terceros'. Pasa km como n\u00famero entero. Si menciona chofer pero no camion, dejas camion vacio (el bot busca el camion asignado al chofer). 9) FLETES: cuando el usuario dice 'le hice un flete a [empresa] por $X' o 'flete a Huico por 500mil', usa registrar_flete. El cliente es la empresa contratante, monto es la tarifa que vas a cobrar. 10) MARCAR FLETE COBRADO: cuando dice 'cobré el flete a X' o 'me pagaron el flete', usa marcar_flete_cobrado. 11) CONSULTAR BALANCE: cuando dice 'como viene el mes', 'cuanto gane', 'balance', 'cuanto factuté', usa consultar_balance. 12) CONSULTAR VENCIMIENTOS: cuando dice 'que vence', 'que tengo que pagar pronto', 'que se viene', 'cheques por cobrar', usa consultar_vencimientos. La cantidad de días por defecto es 30. Si dice 'esta semana' usa cantidad=7, si dice 'este mes' usa cantidad=30. 13) ELIMINAR VIAJE/FLETE: igual que las otras eliminaciones, usa eliminar_viaje o eliminar_flete según el contexto. 15) TRACTOR vs SEMIRREMOLQUE - MUY IMPORTANTE: Cada UC-XX es el TRACTOR (camion). El semirremolque es la cisterna que arrastra (codigo SR-XX). Tienen documentos SEPARADOS. CUANDO REGISTRES UN VENCIMIENTO: si el usuario dice expl\u00edcitamente 'del SEMI', 'del semirremolque', 'de la cisterna', 'del trailer', o si menciona tipo cisterna_adr, rta, o extintor, usa registrar_venc_semi (no registrar_venc_camion). Si dice 'del UC-01', 'del cami\u00f3n', 'del tractor' o no aclara, usa registrar_venc_camion. PARA REGISTRAR_VENC_SEMI: en datos pone 'semi' con el c\u00f3digo SR-XX. Si NO sabe el c\u00f3digo del semi pero sabe a qu\u00e9 cami\u00f3n est\u00e1 asignado (ej 'el semi del UC-01'), pasa camion='UC-01' Y semi vacio. PARA REGISTRAR_SEMI: cuando dice 'agreg\u00e1 un semi nuevo'. PARA ASIGNAR_SEMI: cuando dice 'asign\u00e1 el SR-02 al UC-03'. 14) CONSULTAR ARCHIVO: cuando dice 'mandame la VTV de UC-01', 'pasame la foto del seguro de UC-03', 'la cédula del 02', 'la foto del registro de Luis', 'fotos del camión 5', usa consultar_archivo. En 'datos' pone chofer o camion según corresponda, y categoria con el tipo de archivo si lo menciona (vtv, seguro, cedula, foto, registro, dni, art, factura, recibo, cheque, etc). TIPOS VENC CAMION (TRACTOR): vtv, seguro, habilitacion_cnrt, service, cedula. TIPOS VENC SEMI: vtv, seguro, cisterna_adr, extintor, rta, patente. TIPOS VENC CHOFER: registro_conducir, seguro_art, cargas_peligrosas_cnrt, psicofisico, conduccion_defensiva, libreta_sanitaria. Para choferes usa siempre el apellido. Responde siempre JSON puro sin markdown. Si el mensaje incluye UNA sola operación, devolvé UN objeto: {\"accion\":\"...\",\"datos\":{...},\"mensaje\":\"...\"}. Si el mensaje incluye VARIAS operaciones, devolvé un ARRAY de objetos. La estructura interna de cada objeto es exactamente: {\"accion\":\"nombre\",\"datos\":{\"litros\":0,\"precio_litro\":0,\"producto\":\"\",\"cliente\":\"\",\"proveedor\":\"\",\"camion\":\"\",\"semi\":\"\",\"chofer\":\"\",\"monto\":0,\"km\":0,\"origen\":\"\",\"destino\":\"\",\"tipo\":\"\",\"categoria\":\"\",\"forma_pago\":\"\",\"estado_pago\":\"\",\"cantidad\":\"\",\"mes\":0,\"anio\":0,\"fecha_vencimiento\":\"\",\"descripcion\":\"\"},\"mensaje\":\"\"}";

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
  return contexto + " " + SYSTEM_BASE;
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
function mP(t) { if (!t) return "gas_oil_g2"; var x=t.toLowerCase(); if (x.includes("super")||x.includes("sup")) return "nafta_super"; if (x.includes("infinia")) return "infinia_diesel"; if (x.includes("premium")||x.includes("euro")) return "gas_oil_premium"; return "gas_oil_g2"; }
function fmt(n) { return "$"+Number(n).toLocaleString("es-AR"); }

async function find(tabla,campo,valor) { if (!valor) return null; var r=await db.from(tabla).select("id,"+campo).ilike(campo,"%"+valor+"%").limit(1); return r.data&&r.data[0]?r.data[0]:null; }

async function findChofer(valor) {
  if (!valor) return null;
  // normalizar: lowercase + sin tildes
  var norm = function(s){ return (s||"").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim(); };
  var v = norm(valor);
  if (!v) return null;
  // buscar amplio
  var r = await db.from("choferes").select("id,nombre,apellido,sueldo_fijo,variable_por_km,variable_por_viaje").or("apellido.ilike.%"+valor+"%,nombre.ilike.%"+valor+"%").limit(10);
  var lista = (r.data && r.data.length) ? r.data : [];
  // si no encontró nada, traer todos y filtrar a mano (por si hay tildes)
  if (!lista.length) {
    var todos = await db.from("choferes").select("id,nombre,apellido,sueldo_fijo,variable_por_km,variable_por_viaje");
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

async function run(accion,datos) {
  try {
    if (accion==="registrar_compra") {
      var p=await find("proveedores","nombre",datos.proveedor);
      var l=pM(datos.litros);
      var pr=pM(datos.precio_litro);
      if (!l||!pr) return {ok:false,msg:"Faltan litros o precio"};
      // Validación: precio sospechoso (combustible normalmente entre 500 y 5000)
      if (pr < 100) return {ok:false,msg:"⚠️ Precio sospechoso: $"+pr+" por litro parece muy bajo. ¿Quisiste decir $"+(pr*100)+"? Volvé a mandar el mensaje aclarando el precio."};
      var estPago=datos.estado_pago==="pagada"?"pagada":"pendiente";
      var e=await db.from("compras").insert([{proveedor_id:p?p.id:null,fecha:hoy(),producto:mP(datos.producto),litros:l,precio_litro:pr,estado_pago:estPago}]);
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
      var e=await db.from("ventas").insert([{cliente_id:c?c.id:null,fecha:hoy(),producto:mP(datos.producto),litros:l,precio_litro_venta:pr,condicion_pago:condPago,estado_cobro:estadoCb}]);
      if (e.error) return {ok:false,msg:e.error.message};
      // Si la venta queda cobrada al momento (efectivo/transferencia), crear también el registro de cobranza
      // para que aparezca en la vista de Cobranzas y los totales cuadren
      if (cobradaAlMomento && c) {
        await db.from("cobranzas").insert([{
          cliente_id: c.id,
          tipo: fp,
          monto: totalVenta,
          fecha_emision: hoy(),
          estado: "cobrado",
          notas: "Auto: venta " + l + "L a $" + pr
        }]);
      }
      var estTxt=cobradaAlMomento?" [COBRADA en "+fp+"]":" [a cuenta corriente]";
      return {ok:true,msg:"Venta OK"+estTxt+"\n"+(c?c.nombre:datos.cliente||"?")+"\n"+l.toLocaleString("es-AR")+"L a "+fmt(pr)+"\nTotal: "+fmt(totalVenta)};
    }

    if (accion==="registrar_cobro") { var c=await find("clientes","nombre",datos.cliente); var m=pM(datos.monto); if (!m) return {ok:false,msg:"Falta el monto"}; var t=datos.tipo||"efectivo"; var e=await db.from("cobranzas").insert([{cliente_id:c?c.id:null,tipo:t,monto:m,fecha_emision:hoy(),estado:t==="efectivo"||t==="transferencia"?"cobrado":"pendiente"}]); if (e.error) return {ok:false,msg:e.error.message}; if (c) { await db.from("ventas").update({estado_cobro:"cobrado"}).eq("cliente_id",c.id).eq("estado_cobro","pendiente"); } return {ok:true,msg:"Cobro OK\n"+(c?c.nombre:datos.cliente||"?")+"\n"+fmt(m)+" en "+t}; }

    // GASTO CAMION (con chofer opcional si fue rendido por un chofer)
    if (accion==="registrar_gasto") {
      var cam=await find("camiones","codigo",datos.camion);
      var ch=datos.chofer?await findChofer(datos.chofer):null;
      var m=pM(datos.monto);
      if (!m) return {ok:false,msg:"Falta el monto"};
      var e=await db.from("gastos_camiones").insert([{camion_id:cam?cam.id:null,chofer_id:ch?ch.id:null,fecha:hoy(),categoria:datos.categoria||"otro",monto:m,descripcion:datos.descripcion||null,proveedor:datos.proveedor||null}]);
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
      var e=await db.from("entregas_choferes").insert([{chofer_id:ch.id,fecha:hoy(),categoria:cat,monto:m,descripcion:datos.descripcion||null}]);
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
      var e=await db.from("documentos_camiones").insert([{camion_id:cam.id,tipo:tipoVenc,fecha_vencimiento:fechaParsed,notas:datos.descripcion||null}]);
      if (e.error) return {ok:false,msg:e.error.message};
      var sufijo = reemplazos > 0 ? "\n♻️ Reemplazó "+reemplazos+" vencimiento"+(reemplazos>1?"s":"")+" anterior"+(reemplazos>1?"es":"") : "";
      return {ok:true,msg:"✅ Vencimiento OK\n"+cam.codigo+" - "+tipoVenc+"\nVence: "+fechaParsed+sufijo};
    }

    if (accion==="registrar_venc_chofer") {
      var ch=await findChofer(datos.chofer);
      if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer+". Usa el apellido exacto."};
      var fechaParsed = parseFecha(datos.fecha_vencimiento);
      if (!fechaParsed) return {ok:false,msg:"Fecha inválida. Mandá la fecha en formato DD/MM/AAAA (ej: 14/04/2027)"};
      var tipoVenc = datos.tipo || "registro_conducir";
      // Buscar si ya existe un vencimiento del mismo tipo (renovación)
      var prev = await db.from("documentos_choferes").select("id,fecha_vencimiento").eq("chofer_id", ch.id).eq("tipo", tipoVenc);
      var reemplazos = (prev.data || []).length;
      if (reemplazos > 0) {
        await db.from("documentos_choferes").delete().eq("chofer_id", ch.id).eq("tipo", tipoVenc);
      }
      var e=await db.from("documentos_choferes").insert([{chofer_id:ch.id,tipo:tipoVenc,fecha_vencimiento:fechaParsed,notas:datos.descripcion||null}]);
      if (e.error) return {ok:false,msg:e.error.message};
      var sufijo = reemplazos > 0 ? "\n♻️ Reemplazó "+reemplazos+" vencimiento"+(reemplazos>1?"s":"")+" anterior"+(reemplazos>1?"es":"") : "";
      return {ok:true,msg:"✅ Vencimiento OK\n"+ch.nombre+" "+ch.apellido+" - "+tipoVenc+"\nVence: "+fechaParsed+sufijo};
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
      var eS = await db.from("documentos_semirremolques").insert([{semirremolque_id:semi.id, tipo:tipoVS, fecha_vencimiento:fechaP, notas:datos.descripcion||null}]);
      if (eS.error) return {ok:false,msg:eS.error.message};
      var sufS = reemplS > 0 ? "\n♻️ Reemplazó "+reemplS+" vencimiento"+(reemplS>1?"s":"")+" anterior"+(reemplS>1?"es":"") : "";
      return {ok:true,msg:"✅ Vencimiento OK\n🚚 "+semi.codigo+(semi.patente?" ("+semi.patente+")":"")+" - "+tipoVS+"\nVence: "+fechaP+sufS};
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

// Parser robusto: limpia markdown, escapes inválidos, y usa balanceo de llaves
function extraerJSON(texto) {
  if (!texto) return null;
  var t = texto.replace(/^```json/gim,"").replace(/^json\s*$/gim,"").replace(/```/g,"").trim();
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

app.post("/webhook",async function(req,res){
  var from=req.body.From; var body=req.body.Body?req.body.Body.trim():"";
  if (!body) return res.status(200).send("<Response></Response>");
  console.log("Msg: "+body);
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
      parsed = {accion:"responder",datos:{},mensaje:texto};
    }

    // Si el modelo devolvió un ARRAY, ejecutar cada operación y armar resumen
    var archivosAEnviar = [];
    if (Array.isArray(parsed)) {
      var msgs = [];
      var okCount = 0, errCount = 0;
      for (var i=0; i<parsed.length; i++) {
        var op = parsed[i];
        if (op && op.accion && op.accion !== "responder") {
          var r = await run(op.accion, op.datos || {});
          if (r.ok) { okCount++; msgs.push((i+1)+") "+(r.msg || op.mensaje || "Listo")); }
          else { errCount++; msgs.push((i+1)+") ❌ "+(r.msg || "Error")); }
          // Recolectar archivos si la acción los devolvió
          if (r.archivos && r.archivos.length) archivosAEnviar = archivosAEnviar.concat(r.archivos);
        } else if (op && op.mensaje) {
          msgs.push((i+1)+") "+op.mensaje);
        }
      }
      var header = "Procesé "+parsed.length+" operaciones ("+okCount+" OK"+(errCount?", "+errCount+" con error":"")+"):\n\n";
      respuesta = header + msgs.join("\n\n");
    }
    // Si fue un solo objeto, comportamiento original
    else if (parsed.accion && parsed.accion !== "responder") {
      var r = await run(parsed.accion, parsed.datos || {});
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
app.listen(PORT,function(){console.log("Bot andando en puerto "+PORT);});
