// =====================================================================
// CHAT CON IA de La Unión Car
// Responde consultas con datos reales (cuentas, cheques, ventas, compras)
// y prepara operaciones para cargar. NUNCA guarda solo: devuelve
// "propuestas" que el usuario confirma con un botón en la app.
// Usa: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY (service_role)
// Opcional: MODELO_CHAT (por defecto claude-sonnet-5-5)
// =====================================================================
var express = require('express');
var supabaseLib = require('@supabase/supabase-js');
var _sb = null;
function sb() {
  if(!_sb) _sb = supabaseLib.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);
  return _sb;
}
function chk(r) { if(r.error) throw new Error(r.error.message); return r.data || []; }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
function hoyAR() {
  var d = new Date(Date.now() - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function sumarDias(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function redondo(n) { return Math.round(Number(n || 0) * 100) / 100; }

function postJSON(url, headers, cuerpo) {
  return new Promise(function(ok, mal) {
    var u = new URL(url);
    var datos = JSON.stringify(cuerpo);
    var req = require('https').request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) }, headers) }, function(res) {
      var t = ''; res.on('data', function(c) { t += c; }); res.on('end', function() {
        if(res.statusCode >= 300) return mal(new Error('IA ' + res.statusCode + ': ' + t.substring(0, 300)));
        try { ok(JSON.parse(t)); } catch(e) { mal(e); }
      });
    });
    req.on('error', mal); req.write(datos); req.end();
  });
}

// ── Datos base (con caché corto) ──
var _cache = { ts: 0 };
async function base() {
  if(Date.now() - _cache.ts < 60000 && _cache.terceros) return _cache;
  var r = await Promise.all([
    sb().from('terceros').select('id,nombre,es_cliente,es_proveedor,es_vendedor'),
    sb().from('terceros_alias').select('tercero_id,alias'),
    sb().from('saldos_terceros').select('tercero_id,saldo,ultimo_movimiento'),
    sb().from('productos').select('id,nombre,tipo').eq('activo', true),
    sb().from('productos_alias').select('producto_id,alias'),
    sb().from('empresas').select('id,nombre')
  ]);
  var alias = {}; chk(r[1]).forEach(function(a) { (alias[a.tercero_id] = alias[a.tercero_id] || []).push(a.alias); });
  var saldo = {}, ult = {};
  chk(r[2]).forEach(function(s) { saldo[s.tercero_id] = (saldo[s.tercero_id] || 0) + Number(s.saldo || 0); if(!ult[s.tercero_id] || s.ultimo_movimiento > ult[s.tercero_id]) ult[s.tercero_id] = s.ultimo_movimiento; });
  _cache = {
    ts: Date.now(),
    terceros: chk(r[0]).map(function(t) { t.alias = alias[t.id] || []; t.saldo = redondo(saldo[t.id]); t.ultimo = ult[t.id] || null; return t; }),
    productos: chk(r[3]), prodAlias: chk(r[4]), empresas: chk(r[5])
  };
  return _cache;
}
function tipoTercero(t) { return [t.es_cliente ? 'cliente' : '', t.es_proveedor ? 'proveedor' : '', t.es_vendedor ? 'vendedor' : ''].filter(Boolean).join('/') || 'a definir'; }
function leerSaldo(t) {
  if(Math.abs(t.saldo) < 0.5) return 'saldada';
  var prov = t.es_proveedor && !t.es_cliente;
  if(t.saldo > 0) return (prov ? 'saldo a nuestro favor de $' : 'nos debe $') + t.saldo.toLocaleString('es-AR');
  return (prov ? 'le debemos $' : 'saldo a favor del cliente de $') + (-t.saldo).toLocaleString('es-AR');
}

async function resolverCuenta(nombre) {
  var B = await base(), q = norm(nombre);
  if(!q) return { error: 'Falta el nombre de la cuenta' };
  var exacto = B.terceros.filter(function(t) { return norm(t.nombre) === q || t.alias.some(function(a) { return norm(a) === q; }); });
  if(exacto.length === 1) return { cuenta: exacto[0] };
  var parcial = B.terceros.filter(function(t) { return norm(t.nombre).indexOf(q) >= 0 || t.alias.some(function(a) { return norm(a).indexOf(q) >= 0; }) || q.indexOf(norm(t.nombre)) >= 0; });
  if(parcial.length === 1) return { cuenta: parcial[0] };
  if(parcial.length > 1) return { error: 'Hay varias cuentas que coinciden con "' + nombre + '"', opciones: parcial.slice(0, 8).map(function(t) { return t.nombre; }) };
  return { error: 'No encontré ninguna cuenta llamada "' + nombre + '"' };
}
async function resolverProducto(txt) {
  if(!txt) return null;
  var B = await base(), q = norm(txt);
  var p = B.productos.filter(function(x) { return norm(x.nombre) === q; })[0];
  if(p) return p;
  var a = B.prodAlias.filter(function(x) { return norm(x.alias) === q; })[0];
  if(a) return B.productos.filter(function(x) { return x.id === a.producto_id; })[0];
  return B.productos.filter(function(x) { return norm(x.nombre).indexOf(q) >= 0 || q.indexOf(norm(x.nombre)) >= 0; })[0] || null;
}

// ── HERRAMIENTAS ──
var HERRAMIENTAS = [
  { name: 'buscar_cuentas', description: 'Lista cuentas corrientes (clientes y proveedores) con su saldo. Saldo positivo = nos debe (o en un proveedor: a nuestro favor); negativo = le debemos. Sirve para "quién nos debe más", "cuánto le debemos a los proveedores", buscar una cuenta por nombre o alias.',
    input_schema: { type: 'object', properties: {
      texto: { type: 'string', description: 'Parte del nombre o alias (opcional)' },
      tipo: { type: 'string', enum: ['cliente', 'proveedor', 'todos'] },
      saldo_minimo: { type: 'number', description: 'Solo cuentas con saldo mayor o igual (positivo = nos deben)' },
      saldo_maximo: { type: 'number', description: 'Solo cuentas con saldo menor o igual (para "le debemos", usar negativo)' },
      limite: { type: 'integer' } } } },
  { name: 'estado_de_cuenta', description: 'Resumen y movimientos de UNA cuenta: saldo, lo vendido/cobrado o comprado/pagado en un período y los últimos movimientos con su saldo acumulado.',
    input_schema: { type: 'object', required: ['cuenta'], properties: {
      cuenta: { type: 'string' }, desde: { type: 'string', description: 'AAAA-MM-DD' }, hasta: { type: 'string', description: 'AAAA-MM-DD' },
      ultimos: { type: 'integer', description: 'Cantidad de movimientos a listar (por defecto 15)' } } } },
  { name: 'cheques', description: 'Consulta cheques: en cartera, entregados, depositados, rechazados; por cliente, por número interno o por fecha de cobro. Devuelve lista y totales.',
    input_schema: { type: 'object', properties: {
      estado: { type: 'string', enum: ['cartera', 'entregado', 'depositado', 'acreditado', 'rechazado', 'todos'] },
      cliente: { type: 'string' }, nro_interno: { type: 'integer' }, numero: { type: 'string' },
      fecha_pago_desde: { type: 'string' }, fecha_pago_hasta: { type: 'string' }, limite: { type: 'integer' } } } },
  { name: 'resumen_periodo', description: 'Resumen del negocio entre dos fechas: ventas ($ y litros, por producto y por cliente), compras ($ y litros), cobros y pagos.',
    input_schema: { type: 'object', required: ['desde', 'hasta'], properties: { desde: { type: 'string' }, hasta: { type: 'string' } } } },
  { name: 'pendientes', description: 'Cosas que requieren atención: operaciones sin aprobar, cheques en cartera vencidos o que vencen pronto, ventas sin precio.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'proponer_operacion', description: 'Prepara una operación para cargar (NO la guarda). El usuario la verá en una tarjeta y la confirma con un botón. Usala cuando el usuario quiera registrar una venta, cobro, compra, pago, flete, consumo, pago de un cliente a un tercero, cheque rechazado o ajuste. Si falta un dato imprescindible (cuenta, importe o litros y precio), preguntalo antes.',
    input_schema: { type: 'object', required: ['tipo', 'cuenta'], properties: {
      tipo: { type: 'string', enum: ['venta', 'cobro', 'compra', 'pago', 'flete', 'consumo', 'pago_a_tercero', 'cheque_rechazado', 'ajuste'] },
      cuenta: { type: 'string', description: 'Cliente o proveedor' },
      fecha: { type: 'string', description: 'AAAA-MM-DD (por defecto hoy)' },
      producto: { type: 'string' }, litros: { type: 'number' }, precio_unitario: { type: 'number' },
      importe: { type: 'number', description: 'Total en pesos. En ventas/compras, si no se dice, es litros x precio. En ajustes va con signo.' },
      forma_pago: { type: 'string', enum: ['efectivo', 'transferencia', 'deposito', 'cheque', 'echeq', 'compensacion', 'otro'] },
      destino: { type: 'string', description: 'Para pago_a_tercero: a qué cuenta le pagó el cliente. Para cheque_rechazado: proveedor al que se le había entregado (si corresponde).' },
      destino_texto: { type: 'string', description: 'Para pago_a_tercero a alguien que no es cuenta (mecánico, etc.)' },
      con_factura: { type: 'boolean' }, notas: { type: 'string' } } } }
];

async function ejecutar(nombre, inp, propuestas, usuario) {
  var B = await base(), hoy = hoyAR();
  if(nombre === 'buscar_cuentas') {
    var q = norm(inp.texto), tipo = inp.tipo || 'todos';
    var l = B.terceros.filter(function(t) {
      if(q && norm(t.nombre).indexOf(q) < 0 && !t.alias.some(function(a) { return norm(a).indexOf(q) >= 0; })) return false;
      if(tipo === 'cliente' && !t.es_cliente) return false;
      if(tipo === 'proveedor' && !t.es_proveedor) return false;
      if(inp.saldo_minimo != null && t.saldo < inp.saldo_minimo) return false;
      if(inp.saldo_maximo != null && t.saldo > inp.saldo_maximo) return false;
      return true;
    }).sort(function(a, b) { return Math.abs(b.saldo) - Math.abs(a.saldo); });
    var tot = l.reduce(function(s, t) { return s + t.saldo; }, 0);
    return { cantidad: l.length, suma_saldos: redondo(tot), cuentas: l.slice(0, inp.limite || 20).map(function(t) { return { nombre: t.nombre, tipo: tipoTercero(t), saldo: t.saldo, lectura: leerSaldo(t), ultimo_movimiento: t.ultimo }; }) };
  }
  if(nombre === 'estado_de_cuenta') {
    var rc = await resolverCuenta(inp.cuenta); if(rc.error) return rc;
    var t = rc.cuenta;
    var movs = chk(await sb().from('movimientos_cuenta').select('fecha,importe,operaciones(tipo,litros,precio_unitario,forma_pago,notas,created_at,productos(nombre))').eq('tercero_id', t.id).order('fecha', { ascending: true }));
    movs.sort(function(a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : ((a.operaciones || {}).created_at < (b.operaciones || {}).created_at ? -1 : 1); });
    var saldo = 0, ant = 0, per = [], tot2 = {};
    movs.forEach(function(m) {
      saldo = redondo(saldo + Number(m.importe)); m.saldo = saldo;
      if(inp.desde && m.fecha < inp.desde) { ant = saldo; return; }
      if(inp.hasta && m.fecha > inp.hasta) return;
      per.push(m);
      var tp = (m.operaciones || {}).tipo || 'otro';
      tot2[tp] = tot2[tp] || { cantidad: 0, importe: 0, litros: 0 };
      tot2[tp].cantidad++; tot2[tp].importe = redondo(tot2[tp].importe + Math.abs(Number(m.importe))); tot2[tp].litros += Number((m.operaciones || {}).litros || 0);
    });
    var fin = per.length ? per[per.length - 1].saldo : ant;
    return { cuenta: t.nombre, tipo: tipoTercero(t), saldo_actual: t.saldo, lectura_saldo_actual: leerSaldo(t),
      periodo: { desde: inp.desde || 'inicio', hasta: inp.hasta || 'hoy', saldo_anterior: ant, saldo_al_final: fin, totales_por_tipo: tot2 },
      ultimos_movimientos: per.slice(-(inp.ultimos || 15)).map(function(m) { var o = m.operaciones || {}; return { fecha: m.fecha, tipo: o.tipo, producto: o.productos ? o.productos.nombre : null, litros: o.litros, precio: o.precio_unitario, forma_pago: o.forma_pago, importe_en_cuenta: Number(m.importe), saldo: m.saldo, notas: o.notas }; }) };
  }
  if(nombre === 'cheques') {
    var qy = sb().from('cheques').select('nro_interno,tipo,banco,numero,importe,fecha_pago,fecha_recibido,estado,fecha_entregado,referencia_cliente,firmante,recibido:terceros!cheques_recibido_de_fkey(nombre),entregado:terceros!cheques_entregado_a_fkey(nombre)').order('fecha_pago', { ascending: true });
    var est = inp.estado || (inp.nro_interno || inp.numero ? 'todos' : 'cartera');
    if(est !== 'todos') qy = qy.eq('estado', est);
    if(inp.nro_interno) qy = qy.eq('nro_interno', inp.nro_interno);
    if(inp.numero) qy = qy.ilike('numero', '%' + inp.numero + '%');
    if(inp.fecha_pago_desde) qy = qy.gte('fecha_pago', inp.fecha_pago_desde);
    if(inp.fecha_pago_hasta) qy = qy.lte('fecha_pago', inp.fecha_pago_hasta);
    var ch = chk(await qy);
    if(inp.cliente) {
      var rc2 = await resolverCuenta(inp.cliente);
      var nomC = rc2.cuenta ? norm(rc2.cuenta.nombre) : norm(inp.cliente);
      ch = ch.filter(function(c) { return norm(c.recibido ? c.recibido.nombre : '') === nomC || norm(c.referencia_cliente).indexOf(norm(inp.cliente)) >= 0; });
    }
    return { cantidad: ch.length, total: redondo(ch.reduce(function(s, c) { return s + Number(c.importe); }, 0)), hoy: hoy,
      cheques: ch.slice(0, inp.limite || 30).map(function(c) { return { nro_interno: c.nro_interno, cliente: c.recibido ? c.recibido.nombre : c.referencia_cliente, banco: c.banco, numero: c.numero, importe: Number(c.importe), fecha_cobro: c.fecha_pago, estado: c.estado, entregado_a: c.entregado ? c.entregado.nombre : null, fecha_entregado: c.fecha_entregado }; }) };
  }
  if(nombre === 'resumen_periodo') {
    var rr = await Promise.all([
      sb().from('v_ventas').select('total_venta,litros,producto,clientes').gte('fecha', inp.desde).lte('fecha', inp.hasta),
      sb().from('v_compras').select('total,litros,producto,proveedores').gte('fecha', inp.desde).lte('fecha', inp.hasta),
      sb().from('v_cobranzas').select('monto').gte('fecha_emision', inp.desde).lte('fecha_emision', inp.hasta),
      sb().from('v_pagos_proveedores').select('monto').gte('fecha', inp.desde).lte('fecha', inp.hasta)
    ]);
    var v = chk(rr[0]), c = chk(rr[1]);
    var porProd = {}, porCli = {}, porProv = {};
    v.forEach(function(x) { var p = x.producto || '—'; porProd[p] = porProd[p] || { importe: 0, litros: 0 }; porProd[p].importe += Number(x.total_venta); if(p !== 'Flete') porProd[p].litros += Number(x.litros); var n = x.clientes ? x.clientes.nombre : '—'; porCli[n] = (porCli[n] || 0) + Number(x.total_venta); });
    c.forEach(function(x) { var n = x.proveedores ? x.proveedores.nombre : '—'; porProv[n] = (porProv[n] || 0) + Number(x.total); });
    var top = function(o) { return Object.keys(o).map(function(k) { return { nombre: k, importe: redondo(o[k]) }; }).sort(function(a, b) { return b.importe - a.importe; }).slice(0, 8); };
    return { desde: inp.desde, hasta: inp.hasta,
      ventas: { importe: redondo(v.reduce(function(s, x) { return s + Number(x.total_venta); }, 0)), litros: v.filter(function(x) { return x.producto !== 'Flete'; }).reduce(function(s, x) { return s + Number(x.litros); }, 0), operaciones: v.length, por_producto: porProd, principales_clientes: top(porCli) },
      compras: { importe: redondo(c.reduce(function(s, x) { return s + Number(x.total); }, 0)), litros: c.reduce(function(s, x) { return s + Number(x.litros); }, 0), operaciones: c.length, principales_proveedores: top(porProv) },
      cobros: redondo(chk(rr[2]).reduce(function(s, x) { return s + Number(x.monto); }, 0)),
      pagos_a_proveedores: redondo(chk(rr[3]).reduce(function(s, x) { return s + Number(x.monto); }, 0)),
      aviso: inp.desde < '2026-10-01' ? 'Antes del 01/10/2026 las ventas solo incluyen las cuentas con historial importado; las compras están completas.' : null };
  }
  if(nombre === 'pendientes') {
    var r3 = await Promise.all([
      sb().from('operaciones').select('id', { count: 'exact', head: true }).eq('revisada', false),
      sb().from('cheques').select('nro_interno,importe,fecha_pago,referencia_cliente').eq('estado', 'cartera').lte('fecha_pago', sumarDias(hoy, 7)).order('fecha_pago'),
      sb().from('operaciones').select('fecha,notas,terceros!operaciones_tercero_id_fkey(nombre)').eq('tipo', 'venta').eq('importe', 0)
    ]);
    var chq = chk(r3[1]);
    var venc = chq.filter(function(c) { return c.fecha_pago < hoy; }), prox = chq.filter(function(c) { return c.fecha_pago >= hoy; });
    var s = function(a) { return redondo(a.reduce(function(x, c) { return x + Number(c.importe); }, 0)); };
    return { operaciones_sin_aprobar: r3[0].count || 0,
      cheques_cartera_vencidos: { cantidad: venc.length, total: s(venc) },
      cheques_que_vencen_en_7_dias: { cantidad: prox.length, total: s(prox), detalle: prox.slice(0, 15) },
      ventas_sin_precio: chk(r3[2]).map(function(o) { return { fecha: o.fecha, cliente: o.terceros ? o.terceros.nombre : '', notas: o.notas }; }) };
  }
  if(nombre === 'proponer_operacion') {
    var rc3 = await resolverCuenta(inp.cuenta); if(rc3.error) return rc3;
    var p = { tipo: inp.tipo, fecha: inp.fecha || hoy, tercero_id: rc3.cuenta.id, cuenta: rc3.cuenta.nombre, notas: inp.notas || null,
              forma_pago: inp.forma_pago || null, con_factura: inp.con_factura == null ? null : !!inp.con_factura };
    if(inp.producto) { var pr = await resolverProducto(inp.producto); if(pr) { p.producto_id = pr.id; p.producto = pr.nombre; } }
    if(!p.producto_id && (inp.tipo === 'venta' || inp.tipo === 'compra' || inp.tipo === 'consumo') && inp.litros) { var g = await resolverProducto('gasoil'); if(g) { p.producto_id = g.id; p.producto = g.nombre; } }
    if(inp.tipo === 'flete') { var fl = await resolverProducto('flete'); if(fl) { p.producto_id = fl.id; p.producto = fl.nombre; } }
    if(inp.litros) p.litros = Number(inp.litros);
    if(inp.precio_unitario) p.precio_unitario = Number(inp.precio_unitario);
    p.importe = inp.importe != null ? Number(inp.importe) : (p.litros && p.precio_unitario ? redondo(p.litros * p.precio_unitario) : null);
    if(p.importe == null || (inp.tipo !== 'ajuste' && !(p.importe > 0))) return { error: 'Falta el importe (o litros y precio). Preguntáselo al usuario.' };
    if(inp.destino) { var rd = await resolverCuenta(inp.destino); if(rd.error) return rd; p.destino_tercero_id = rd.cuenta.id; p.destino = rd.cuenta.nombre; }
    if(inp.destino_texto) p.destino_texto = inp.destino_texto;
    if(inp.tipo === 'pago_a_tercero' && !p.destino_tercero_id && !p.destino_texto) return { error: 'Falta a quién le pagó el cliente.' };
    var emp = B.empresas.filter(function(e) { return e.nombre === 'La Unión Car SRL'; })[0];
    p.empresa_id = emp ? emp.id : null;
    p.cuenta_saldo_actual = leerSaldo(rc3.cuenta);
    propuestas.push(p);
    return { ok: true, mensaje: 'Propuesta preparada. NO está guardada: el usuario la ve en una tarjeta y la confirma con el botón "Confirmar".', propuesta: p };
  }
  return { error: 'Herramienta desconocida' };
}

function sistema(usuario) {
  var hoy = hoyAR();
  return 'Sos el asistente de gestión de La Unión Car SRL (transporte y venta de combustibles, marca Petro del Norte, Argentina). Hoy es ' + hoy + '. ' +
    'Estás hablando con ' + (usuario.nombre || 'un usuario') + ' (rol: ' + (usuario.rol || '?') + '). Respondé en español rioplatense, claro y breve, como un administrativo que conoce el negocio. ' +
    'REGLAS: 1) Para cualquier dato usá SIEMPRE las herramientas; nunca inventes saldos, importes ni cheques. ' +
    '2) Saldos: positivo = el cliente nos debe (en un proveedor, saldo a nuestro favor); negativo = le debemos (o saldo a favor del cliente). Decilo así, no con signos. ' +
    '3) Montos en formato argentino: $ 1.234.567,89. Litros con punto de miles. Fechas DD/MM/AAAA. ' +
    '4) Para registrar algo usá proponer_operacion. Nunca digas que quedó guardado: decí que preparaste la operación y que la confirme con el botón. Si falta un dato imprescindible, preguntalo en una sola pregunta. ' +
    '5) Interpretá el lenguaje del negocio: "go", "gasoil" = Gasoil; "super" = Nafta Súper; "x10" = X10; "eft"/"efvo" = efectivo; "ch" = cheque; "tr"/"transf" = transferencia; "50 mil" = 50000; "1,5 M" = 1500000. Precios de combustible entre 800 y 4000 por litro. ' +
    '6) Vender a un cliente sin decir cómo pagó = venta en cuenta corriente (sin cobro). Si dice que pagó en el momento, proponé la venta y además el cobro. ' +
    '7) Si un cliente le pagó directo a un proveedor (ej. "Junes le transfirió 4 M a Copsa"), es pago_a_tercero con cuenta=cliente y destino=proveedor. ' +
    '8) Los cheques recibidos se cargan desde la sección Cheques con fotos (lee varios cheques y el N° interno); si quieren cargar cheques, indicales eso. ' +
    '9) Antes del 01/10/2026 los datos de ventas están incompletos para algunas cuentas; si consultan meses anteriores, avisalo. ' +
    '10) Sé breve: listas cortas, totales al final. Si piden "más detalle", ampliá.';
}

async function conversar(mensajes, usuario) {
  var propuestas = [], hist = mensajes.slice(-16).map(function(m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }; });
  while(hist.length && hist[0].role !== 'user') hist.shift();
  for(var vuelta = 0; vuelta < 7; vuelta++) {
    var r = await postJSON('https://api.anthropic.com/v1/messages',
      { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: process.env.MODELO_CHAT || 'claude-sonnet-5-5', max_tokens: 2500, system: sistema(usuario), tools: HERRAMIENTAS, messages: hist });
    var bloques = r.content || [];
    if(r.stop_reason !== 'tool_use') {
      return { respuesta: bloques.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n').trim(), propuestas: propuestas };
    }
    hist.push({ role: 'assistant', content: bloques });
    var resultados = [];
    for(var i = 0; i < bloques.length; i++) {
      var b = bloques[i];
      if(b.type !== 'tool_use') continue;
      var out;
      try { out = await ejecutar(b.name, b.input || {}, propuestas, usuario); } catch(e) { out = { error: e.message }; }
      resultados.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).substring(0, 60000) });
    }
    hist.push({ role: 'user', content: resultados });
  }
  return { respuesta: 'No pude terminar la consulta, probá preguntarlo de otra forma.', propuestas: propuestas };
}

module.exports = function(app) {
  app.post('/chat', express.text({ type: 'text/plain', limit: '2mb' }), async function(req, res) {
    try {
      var b = JSON.parse(req.body || '{}');
      var u = await sb().auth.getUser(b.token || '');
      if(u.error || !u.data || !u.data.user) return res.status(401).json({ error: 'Iniciá sesión en la app' });
      var perfil = chk(await sb().from('perfiles').select('nombre,rol,activo').eq('id', u.data.user.id))[0];
      if(!perfil || !perfil.activo) return res.status(403).json({ error: 'Usuario sin acceso' });
      var r = await conversar(b.mensajes || [], perfil);
      res.json({ ok: true, respuesta: r.respuesta, propuestas: r.propuestas });
    } catch(e) {
      console.error('❌ Chat:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
  console.log('💬 Chat con IA activo');
};
