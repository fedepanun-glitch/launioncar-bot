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

var SYSTEM = "Sos el asistente de La Union Car SRL. Interpretas mensajes en argentino informal. CAMIONES: UC-01=Enrique Cefferino, UC-02=Juan Benitez, UC-03=Fernando Freire, UC-04=Gustavo Fernandez, UC-05=Pablo Herrera, UC-06=Juan Romero. PRODUCTOS: gasoil=gas_oil_g2, premium=gas_oil_premium, super=nafta_super, infinia=infinia_diesel. ACCIONES: registrar_compra, registrar_venta, registrar_cobro, registrar_gasto, registrar_entrega, registrar_sueldo, registrar_venc_camion, registrar_venc_chofer, consultar_stock, consultar_saldo, consultar_ventas_hoy, consultar_alertas, consultar_chofer, responder. CRITERIO IMPORTANTE: 1) Si el dinero se gasta en algo del CAMION (reparacion, neumaticos, lubricantes, repuestos, peaje, combustible para el camion) usa registrar_gasto. Si vino de la rendicion de un chofer agrega su apellido. 2) Si le DAS plata al chofer en mano (adelanto, viatico, comida, plata para gastos, dietario) usa registrar_entrega. Categorias entregas: adelanto_sueldo, viatico, peaje, combustible, comida, otro. 3) Si liquidas el SUELDO mensual de un chofer usa registrar_sueldo (necesita chofer + mes + anio). El sueldo se calcula solo, no pidas montos. 4) Para preguntas tipo cuanto le debo a Juan o cuenta de Benitez usa consultar_chofer. TIPOS VENC CAMION: vtv, seguro, habilitacion_cnrt, extintor, cisterna_adr, service. TIPOS VENC CHOFER: registro_conducir, seguro_art, cargas_peligrosas_cnrt, psicofisico, conduccion_defensiva, libreta_sanitaria. Para choferes usa siempre el apellido. Responde siempre JSON puro sin markdown con esta estructura exacta: {\"accion\":\"nombre\",\"datos\":{\"litros\":0,\"precio_litro\":0,\"producto\":\"\",\"cliente\":\"\",\"proveedor\":\"\",\"camion\":\"\",\"chofer\":\"\",\"monto\":0,\"tipo\":\"\",\"categoria\":\"\",\"mes\":0,\"anio\":0,\"fecha_vencimiento\":\"\",\"descripcion\":\"\"},\"mensaje\":\"\"}";

function hoy() { return new Date().toISOString().split("T")[0]; }
function pM(s) { if (!s) return null; var x=s.toString().replace(/[$]/g,"").replace(/[.]/g,"").replace(/,/g,".").trim(); if (x.toUpperCase().endsWith("M")) return parseFloat(x)*1000000; if (x.toUpperCase().endsWith("K")) return parseFloat(x)*1000; return parseFloat(x); }
function mP(t) { if (!t) return "gas_oil_g2"; var x=t.toLowerCase(); if (x.includes("super")||x.includes("sup")) return "nafta_super"; if (x.includes("infinia")) return "infinia_diesel"; if (x.includes("premium")||x.includes("euro")) return "gas_oil_premium"; return "gas_oil_g2"; }
function fmt(n) { return "$"+Number(n).toLocaleString("es-AR"); }

async function find(tabla,campo,valor) { if (!valor) return null; var r=await db.from(tabla).select("id,"+campo).ilike(campo,"%"+valor+"%").limit(1); return r.data&&r.data[0]?r.data[0]:null; }

async function findChofer(valor) {
  if (!valor) return null;
  var r=await db.from("choferes").select("id,nombre,apellido,sueldo_fijo,variable_por_km,variable_por_viaje").or("apellido.ilike.%"+valor+"%,nombre.ilike.%"+valor+"%").limit(5);
  if (!r.data||!r.data.length) return null;
  if (r.data.length===1) return r.data[0];
  var v=valor.toLowerCase();
  for (var i=0;i<r.data.length;i++) {
    var full=(r.data[i].nombre+" "+r.data[i].apellido).toLowerCase();
    var ap=r.data[i].apellido.toLowerCase();
    if (ap===v||full===v) return r.data[i];
  }
  return r.data[0];
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
    if (accion==="registrar_compra") { var p=await find("proveedores","nombre",datos.proveedor); var l=pM(datos.litros); var pr=pM(datos.precio_litro); if (!l||!pr) return {ok:false,msg:"Faltan litros o precio"}; var e=await db.from("compras").insert([{proveedor_id:p?p.id:null,fecha:hoy(),producto:mP(datos.producto),litros:l,precio_litro:pr,estado_pago:"pagada"}]); if (e.error) return {ok:false,msg:e.error.message}; return {ok:true,msg:"Compra OK\n"+(p?p.nombre:datos.proveedor||"?")+"\n"+l.toLocaleString("es-AR")+"L a "+fmt(pr)+"\nTotal: "+fmt(l*pr)}; }

    if (accion==="registrar_venta") { var c=await find("clientes","nombre",datos.cliente); var l=pM(datos.litros); var pr=pM(datos.precio_litro); if (!l||!pr) return {ok:false,msg:"Faltan litros o precio"}; var e=await db.from("ventas").insert([{cliente_id:c?c.id:null,fecha:hoy(),producto:mP(datos.producto),litros:l,precio_litro_venta:pr,condicion_pago:datos.forma_pago||"cuenta_corriente",estado_cobro:datos.forma_pago==="efectivo"?"cobrado":"pendiente"}]); if (e.error) return {ok:false,msg:e.error.message}; return {ok:true,msg:"Venta OK\n"+(c?c.nombre:datos.cliente||"?")+"\n"+l.toLocaleString("es-AR")+"L a "+fmt(pr)+"\nTotal: "+fmt(l*pr)}; }

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

    return {ok:true,msg:null};
  } catch(e) { return {ok:false,msg:"Error: "+e.message}; }
}

app.get("/",function(req,res){res.json({status:"ok"});});

app.post("/webhook",async function(req,res){
  var from=req.body.From; var body=req.body.Body?req.body.Body.trim():"";
  if (!body) return res.status(200).send("<Response></Response>");
  console.log("Msg: "+body);
  if (!historiales[from]) historiales[from]=[];
  historiales[from].push({role:"user",content:body});
  if (historiales[from].length>16) historiales[from]=historiales[from].slice(-16);
  var respuesta="Error. Intenta de nuevo.";
  try {
    var resp=await ai.messages.create({model:"claude-haiku-4-5-20251001",max_tokens:800,system:SYSTEM,messages:historiales[from]});
    var texto=resp.content[0]?resp.content[0].text:"";
    console.log("AI: "+texto);
    var parsed; try{parsed=JSON.parse(texto.replace(/```json/g,"").replace(/```/g,"").trim());}catch(e){parsed={accion:"responder",datos:{},mensaje:texto};}
    if (parsed.accion&&parsed.accion!=="responder"){var r=await run(parsed.accion,parsed.datos||{});respuesta=r.ok?(r.msg||parsed.mensaje||"Listo!"):(r.msg||"Error.");}
    else{respuesta=parsed.mensaje||texto;}
    historiales[from].push({role:"assistant",content:respuesta});
  } catch(e){console.error(e.message);}
  try{await twilioClient.messages.create({from:process.env.TWILIO_WHATSAPP_NUMBER,to:from,body:respuesta});}catch(e){console.error(e.message);}
  res.status(200).send("<Response></Response>");
});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){console.log("Bot andando en puerto "+PORT);});
