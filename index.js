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

var SYSTEM_BASE = "Sos el asistente de La Union Car SRL. Interpretas mensajes en argentino informal. PRODUCTOS: gasoil=gas_oil_g2, premium=gas_oil_premium, super=nafta_super, infinia=infinia_diesel. ACCIONES: registrar_compra, registrar_venta, registrar_cobro, registrar_gasto, registrar_entrega, registrar_sueldo, registrar_viaje, registrar_flete, registrar_venc_camion, registrar_venc_chofer, eliminar_compra, eliminar_venta, eliminar_gasto, eliminar_entrega, eliminar_cobro, consultar_stock, consultar_saldo, consultar_ventas_hoy, consultar_alertas, consultar_chofer, responder. ⚠️ REGLAS CR\u00cdTICAS DE N\u00daMEROS: Los precios y montos los mandas SIEMPRE como n\u00fameros enteros, NUNCA con decimales. Si el usuario dice '1800' es MIL OCHOCIENTOS, lo mandas como 1800, NO como 18. Si dice '50 mil' o '50K' lo mandas como 50000. Si dice '1.5M' o 'un millon y medio' lo mandas como 1500000. NUNCA dividas un n\u00famero por 100. Precios de combustible normales son entre 800 y 3000 por litro. Si un usuario dice un numero entre 1000 y 3000 para combustible, es ese numero exacto, NO con decimales. REGLAS DE NEGOCIO: 1) COMPRAS: por defecto siempre estado_pago pendiente. Solo marcar pagada si dice 'le pague', 'ya le pague', 'pagada', 'abonada'. 2) VENTAS: si dice 'efectivo', 'transferencia', 'me transfirio' usa forma_pago efectivo o transferencia (queda cobrada). Si dice 'a cuenta corriente', 'fiada', 'a cuenta' o NO menciona forma de pago, usa cuenta_corriente (queda pendiente). 3) GASTOS DE CAMION: si dice 'X cargo combustible', 'X cambio gomas' SIN mencionar que el chofer pago de su plata, NO asocies chofer al gasto. SOLO asocia chofer si dice 'rindio', 'pago con la plata que le di', 'rinde gastos'. 4) ENTREGAS: si le DAS plata al chofer en mano usa registrar_entrega. Categorias: adelanto_sueldo, viatico, peaje, combustible, comida, otro. 5) SUELDOS: para liquidacion mensual usa registrar_sueldo. 6) CONSULTAR CHOFER: para 'cuanto le debo a X' usa consultar_chofer. 7) ELIMINAR: si el usuario pide eliminar/borrar/anular/cancelar/sacar una operacion, usa eliminar_X seg\u00fan el tipo. Captura el dato distintivo: proveedor/cliente/chofer y monto si lo mencionan. Si solo dice 'elimina la ultima X' man\u00e1 sin datos espec\u00edficos. Si dice 'borra TODAS', 'borra las dos', 'borra ambas', 'borra las 3', man\u00e1 \"cantidad\":\"todas\" en datos. 8) VIAJES: cuando el usuario dice 'X hizo Y km', 'el camion Z recorri\u00f3 Y km', 'Luis hizo 300km', usa registrar_viaje. Por defecto tipo='venta_propia'. Si dice 'flete' o 'a terceros' usa tipo='flete_terceros'. Pasa km como n\u00famero entero. Si menciona chofer pero no camion, dejas camion vacio (el bot busca el camion asignado al chofer). 9) FLETES: cuando el usuario dice 'le hice un flete a [empresa] por $X' o 'flete a Huico por 500mil', usa registrar_flete. El cliente es la empresa contratante, monto es la tarifa que vas a cobrar. TIPOS VENC CAMION: vtv, seguro, habilitacion_cnrt, extintor, cisterna_adr, service. TIPOS VENC CHOFER: registro_conducir, seguro_art, cargas_peligrosas_cnrt, psicofisico, conduccion_defensiva, libreta_sanitaria. Para choferes usa siempre el apellido. Responde siempre JSON puro sin markdown. Si el mensaje incluye UNA sola operación, devolvé UN objeto: {\"accion\":\"...\",\"datos\":{...},\"mensaje\":\"...\"}. Si el mensaje incluye VARIAS operaciones, devolvé un ARRAY de objetos. La estructura interna de cada objeto es exactamente: {\"accion\":\"nombre\",\"datos\":{\"litros\":0,\"precio_litro\":0,\"producto\":\"\",\"cliente\":\"\",\"proveedor\":\"\",\"camion\":\"\",\"chofer\":\"\",\"monto\":0,\"km\":0,\"origen\":\"\",\"destino\":\"\",\"tipo\":\"\",\"categoria\":\"\",\"forma_pago\":\"\",\"estado_pago\":\"\",\"cantidad\":\"\",\"mes\":0,\"anio\":0,\"fecha_vencimiento\":\"\",\"descripcion\":\"\"},\"mensaje\":\"\"}";

// Cache de mapping camiones (se refresca cada 60 segundos para no consultar la BD en cada mensaje)
var _camionesMappingCache = null;
var _camionesMappingTs = 0;

async function getCamionesContext() {
  var ahora = Date.now();
  if (_camionesMappingCache && (ahora - _camionesMappingTs) < 60000) {
    return _camionesMappingCache;
  }
  try {
    var r = await db.from("camiones").select("codigo,patente,activo,choferes(nombre,apellido)").eq("activo", true).order("codigo");
    var lista = (r.data || []).map(function(c) {
      var ch = c.choferes ? (c.choferes.nombre + " " + c.choferes.apellido) : "sin chofer";
      return c.codigo + "=" + ch;
    }).join(", ");
    _camionesMappingCache = "CAMIONES (estado actual de la base de datos): " + (lista || "ninguno activo") + ".";
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
      var e=await db.from("ventas").insert([{cliente_id:c?c.id:null,fecha:hoy(),producto:mP(datos.producto),litros:l,precio_litro_venta:pr,condicion_pago:condPago,estado_cobro:estadoCb}]);
      if (e.error) return {ok:false,msg:e.error.message};
      var estTxt=cobradaAlMomento?" [COBRADA en "+fp+"]":" [a cuenta corriente]";
      return {ok:true,msg:"Venta OK"+estTxt+"\n"+(c?c.nombre:datos.cliente||"?")+"\n"+l.toLocaleString("es-AR")+"L a "+fmt(pr)+"\nTotal: "+fmt(l*pr)};
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

    if (accion==="registrar_venc_camion") { var cam=await find("camiones","codigo",datos.camion); if (!cam) return {ok:false,msg:"No encontre el camion "+datos.camion}; if (!datos.fecha_vencimiento) return {ok:false,msg:"Falta la fecha"}; var e=await db.from("documentos_camiones").insert([{camion_id:cam.id,tipo:datos.tipo||"vtv",fecha_vencimiento:datos.fecha_vencimiento,notas:datos.descripcion||null}]); if (e.error) return {ok:false,msg:e.error.message}; return {ok:true,msg:"Vencimiento OK\n"+cam.codigo+" - "+(datos.tipo||"vtv")+"\n"+datos.fecha_vencimiento}; }

    if (accion==="registrar_venc_chofer") { var ch=await findChofer(datos.chofer); if (!ch) return {ok:false,msg:"No encontre al chofer "+datos.chofer+". Usa el apellido exacto."}; if (!datos.fecha_vencimiento) return {ok:false,msg:"Falta la fecha"}; var e=await db.from("documentos_choferes").insert([{chofer_id:ch.id,tipo:datos.tipo||"registro_conducir",fecha_vencimiento:datos.fecha_vencimiento,notas:datos.descripcion||null}]); if (e.error) return {ok:false,msg:e.error.message}; return {ok:true,msg:"Vencimiento OK\n"+ch.nombre+" "+ch.apellido+" - "+(datos.tipo||"registro_conducir")+"\n"+datos.fecha_vencimiento}; }

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
      var fecha = datos.fecha_vencimiento || hoy();
      // Si la fecha viene en formato DD/MM/YYYY o DD/MM convertir a YYYY-MM-DD
      if (fecha && fecha.indexOf("/") !== -1) {
        var p = fecha.split("/");
        if (p.length === 3) { var y = p[2].length === 2 ? "20"+p[2] : p[2]; fecha = y+"-"+p[1].padStart(2,"0")+"-"+p[0].padStart(2,"0"); }
        else fecha = hoy();
      }
      var e = await db.from("viajes").insert([{
        camion_id: cam.id,
        chofer_id: ch ? ch.id : null,
        fecha: fecha,
        km: km,
        origen: datos.origen || null,
        destino: datos.destino || null,
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
    var resp=await ai.messages.create({model:"claude-haiku-4-5-20251001",max_tokens:1500,system:sysPrompt,messages:historiales[from]});
    var texto=resp.content[0]?resp.content[0].text:"";
    console.log("AI: "+texto);

    var parsed = extraerJSON(texto);
    if (!parsed) {
      parsed = {accion:"responder",datos:{},mensaje:texto};
    }

    // Si el modelo devolvió un ARRAY, ejecutar cada operación y armar resumen
    if (Array.isArray(parsed)) {
      var msgs = [];
      var okCount = 0, errCount = 0;
      for (var i=0; i<parsed.length; i++) {
        var op = parsed[i];
        if (op && op.accion && op.accion !== "responder") {
          var r = await run(op.accion, op.datos || {});
          if (r.ok) { okCount++; msgs.push((i+1)+") "+(r.msg || op.mensaje || "Listo")); }
          else { errCount++; msgs.push((i+1)+") ❌ "+(r.msg || "Error")); }
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
    }
    else { respuesta = parsed.mensaje || texto; }

    historiales[from].push({role:"assistant",content:respuesta});
  } catch(e){console.error(e.message);}
  try{await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:respuesta});}catch(e){console.error(e.message);}
  res.status(200).send("<Response></Response>");
});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){console.log("Bot andando en puerto "+PORT);});
