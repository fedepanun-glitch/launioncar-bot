// =====================================================================
// SINCRONIZACIÓN: cuentas corrientes de la app  ->  planillas CC de Drive
// Módulo para el bot de Render (launioncar-bot).
//
// Cómo funciona:
//  - Cada vez que se carga, edita o borra una operación en la app, Supabase
//    le avisa al bot (POST /sync-planilla) qué cuenta cambió.
//  - El bot espera unos segundos (por si se cargan varias juntas) y reescribe
//    los movimientos desde el 01/10/2026 en la planilla CC de esa cuenta.
//  - Además, cada 15 minutos revisa todas las cuentas, por si algún aviso se
//    perdió (por ejemplo, si el bot estaba dormido).
//
// Variables de entorno necesarias en Render:
//  SUPABASE_URL                 https://dkrvppwecqchhiodiosg.supabase.co
//  SUPABASE_KEY (o SUPABASE_SERVICE_KEY)  la "service_role key" de Supabase
//  GOOGLE_SERVICE_ACCOUNT_JSON  el JSON completo de la cuenta de servicio de Google
//  SYNC_SECRET                  una clave inventada (la misma que en el SQL)
// =====================================================================
var express = require('express');
var { google } = require('googleapis');

var FECHA_INICIO = '2026-10-01';
var ETIQUETAS = {
  venta: 'Venta', flete: 'Flete', cobro: 'Cobro', pago_a_tercero: 'Pago a tercero', compra: 'Compra',
  pago: 'Pago', consumo: 'Consumo', cheque_rechazado: 'Cheque rechazado', ajuste: 'Ajuste', saldo_inicial: 'Saldo inicial'
};
var FORMAS = { efectivo: 'Efectivo', transferencia: 'Transferencia', deposito: 'Depósito', cheque: 'Cheque', echeq: 'E-cheq', compensacion: 'Compensación', otro: 'Otro' };

function sheetsCliente() {
  var cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  var auth = new google.auth.JWT(cred.client_email, null, cred.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth: auth });
}

var supabaseLib = require('@supabase/supabase-js');
var _sb = null;
function sb() {
  if(!_sb) _sb = supabaseLib.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);
  return _sb;
}
function chk(r) { if(r.error) throw new Error('Supabase: ' + r.error.message); return r.data || []; }

function fechaAR(iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

async function sincronizarCuenta(terceroId) {
  var ter = chk(await sb().from('terceros').select('nombre,planilla_id').eq('id', terceroId));
  if(!ter.length || !ter[0].planilla_id) return { omitida: true };
  var movs = chk(await sb().from('movimientos_cuenta')
    .select('fecha,importe,operaciones(tipo,litros,precio_unitario,forma_pago,notas,nro_remito,nro_factura,destino_texto,revisada,created_at,productos(nombre),choferes(nombre,apellido),camiones(codigo),empresas(nombre))')
    .eq('tercero_id', terceroId).gte('fecha', FECHA_INICIO).order('fecha', { ascending: true }));
  movs.sort(function(a, b) {
    if(a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
    var ca = a.operaciones ? a.operaciones.created_at : '', cb = b.operaciones ? b.operaciones.created_at : '';
    return ca < cb ? -1 : (ca > cb ? 1 : 0);
  });
  var izq = [], der = [];
  movs.forEach(function(m) {
    var o = m.operaciones || {};
    var imp = Number(m.importe || 0);
    var det = [];
    if(o.productos && o.productos.nombre) det.push(o.productos.nombre);
    if(o.nro_factura) det.push('Fact. ' + o.nro_factura);
    if(o.nro_remito) det.push('Rto. ' + o.nro_remito);
    if(o.destino_texto) det.push('a ' + o.destino_texto);
    if(o.empresas && o.empresas.nombre && o.empresas.nombre !== 'La Unión Car SRL') det.push('Facturó ' + o.empresas.nombre);
    var chofer = [];
    if(o.choferes) chofer.push(((o.choferes.nombre || '') + ' ' + (o.choferes.apellido || '')).trim());
    if(o.camiones && o.camiones.codigo) chofer.push(o.camiones.codigo);
    var notas = ['Cargado en la app'];
    if(o.revisada === false) notas.push('SIN APROBAR');
    if(o.notas) notas.push(o.notas);
    izq.push([fechaAR(m.fecha), ETIQUETAS[o.tipo] || o.tipo || '', det.join(' · '), o.litros || '', o.precio_unitario || '',
              imp >= 0 ? imp : '', imp < 0 ? -imp : '']);
    der.push([FORMAS[o.forma_pago] || '', '', chofer.join(' / '), notas.join(' · ')]);
  });
  var sh = sheetsCliente();
  var id = ter[0].planilla_id;
  await sh.spreadsheets.values.batchClear({ spreadsheetId: id, requestBody: { ranges: ['Cuenta!A10:G1000', 'Cuenta!I10:L1000'] } });
  if(izq.length) {
    var fin = 9 + izq.length;
    await sh.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'USER_ENTERED', data: [
      { range: 'Cuenta!A10:G' + fin, values: izq },
      { range: 'Cuenta!I10:L' + fin, values: der }
    ] } });
  }
  return { cuenta: ter[0].nombre, movimientos: izq.length };
}


// ── PLANILLA DE CHEQUES ──────────────────────────────────────────────
var CHEQUES_SHEET = process.env.CHEQUES_SHEET_ID || '1p6QYiITyrn3FX-pGr3DfNXiZ1Bh5acFi_7E7j4of_b0';
var ESTADOS_CH = { cartera: 'En cartera', entregado: 'Entregado', depositado: 'Depositado', acreditado: 'Cobrado', rechazado: 'Rechazado', recuperado: 'Recuperado', anulado: 'Anulado' };

async function sincronizarCheques() {
  var ch = chk(await sb().from('cheques')
    .select('nro_interno,fecha_recibido,referencia_cliente,numero,banco,fecha_pago,importe,estado,fecha_entregado,tipo,notas,firmante,' +
            'recibido:terceros!cheques_recibido_de_fkey(nombre),entregado:terceros!cheques_entregado_a_fkey(nombre),traido:terceros!cheques_traido_por_fkey(nombre)')
    .order('nro_interno', { ascending: true }));
  var filas = ch.map(function(c) {
    var notas = [];
    if(c.tipo === 'echeq') notas.push('E-cheq');
    if(c.traido) notas.push('Lo trajo ' + c.traido.nombre);
    if(c.firmante) notas.push('Firmante: ' + c.firmante);
    if(c.notas) notas.push(c.notas);
    return [c.nro_interno, c.fecha_recibido ? fechaAR(c.fecha_recibido) : '', c.referencia_cliente || (c.recibido ? c.recibido.nombre : ''),
            c.recibido ? c.recibido.nombre : '', c.numero || '', c.banco || '', c.fecha_pago ? fechaAR(c.fecha_pago) : '', Number(c.importe),
            ESTADOS_CH[c.estado] || c.estado, c.fecha_entregado ? fechaAR(c.fecha_entregado) : '', c.entregado ? c.entregado.nombre : '', notas.join(' · ')];
  });
  var sh = sheetsCliente();
  await sh.spreadsheets.values.clear({ spreadsheetId: CHEQUES_SHEET, range: 'Cheques!A7:L3000' });
  if(filas.length) {
    await sh.spreadsheets.values.update({ spreadsheetId: CHEQUES_SHEET, range: 'Cheques!A7:L' + (6 + filas.length),
      valueInputOption: 'USER_ENTERED', requestBody: { values: filas } });
  }
  return filas.length;
}

var esperandoCheques = null;
function programarCheques() {
  if(esperandoCheques) clearTimeout(esperandoCheques);
  esperandoCheques = setTimeout(function() {
    esperandoCheques = null;
    sincronizarCheques()
      .then(function(n) { console.log('📗 Planilla de cheques actualizada (' + n + ' cheques)'); })
      .catch(function(e) { console.error('❌ Error sincronizando cheques:', e.message); });
  }, 6000);
}

// ── LECTURA DE CHEQUES POR FOTO (IA) ─────────────────────────────────
function postJSON(url, headers, cuerpo) {
  return new Promise(function(ok, mal) {
    var u = new URL(url);
    var datos = JSON.stringify(cuerpo);
    var req = require('https').request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) }, headers) }, function(res) {
      var t = ''; res.on('data', function(c) { t += c; }); res.on('end', function() {
        if(res.statusCode >= 300) return mal(new Error('IA ' + res.statusCode + ': ' + t.substring(0, 200)));
        try { ok(JSON.parse(t)); } catch(e) { mal(e); }
      });
    });
    req.on('error', mal); req.write(datos); req.end();
  });
}

var PROMPT_CHEQUE = 'Sos un asistente que lee cheques argentinos (físicos o e-cheq). La imagen puede tener UNO O VARIOS cheques. ' +
  'Sobre cada cheque físico suele haber un NÚMERO INTERNO escrito a mano (un número de 3 o 4 cifras, por ejemplo 1795), que es el número de control de la empresa: no lo confundas con el número del cheque impreso. ' +
  'Devolvé SOLO un JSON crudo, sin markdown, con esta forma: {"cheques":[{"nro_interno":número escrito a mano o null,"tipo":"fisico" o "echeq","banco":"nombre del banco","numero":"número de cheque impreso, sin espacios",' +
  '"importe":número sin separadores de miles (punto para decimales),"fecha_emision":"AAAA-MM-DD","fecha_pago":"AAAA-MM-DD","firmante":"nombre o razón social del librador","cuit_firmante":"CUIT con guiones",' +
  '"confianza":"alta"/"media"/"baja","observaciones":"lo que no se lea bien"}]}. ' +
  'Un objeto por cada cheque, en el orden en que aparecen (de arriba hacia abajo, de izquierda a derecha). Si un dato no se ve, null. ' +
  'En cheques de pago diferido la fecha de pago es la del texto "el ... de ... de ..." o "fecha de pago". Los importes argentinos usan punto para miles y coma para decimales: convertilos. ' +
  'Usá el importe en números y controlalo con el importe en letras si se ve.';

async function leerCheques(base64, mime) {
  var bloque = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: base64 } };
  var r = await postJSON('https://api.anthropic.com/v1/messages',
    { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { model: process.env.MODELO_CHEQUES || 'claude-sonnet-5-5', max_tokens: 8000,
      messages: [{ role: 'user', content: [ bloque, { type: 'text', text: PROMPT_CHEQUE } ] }] });
  var texto = (r.content || []).map(function(b) { return b.text || ''; }).join('').trim();
  return parsearCheques(texto);
}

// Lectura tolerante: si el JSON completo viene mal armado, rescata cada cheque por separado
function parsearCheques(texto) {
  var t = String(texto || '').replace(/```(json)?/gi, '').trim();
  try {
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    var obj = JSON.parse(t.substring(i, j + 1));
    if(Array.isArray(obj.cheques)) return obj.cheques;
    if(Array.isArray(obj)) return obj;
    return [obj];
  } catch(e) {
    var lista = [];
    var partes = t.match(/\{[^{}]*\}/g) || [];
    partes.forEach(function(p) {
      try { lista.push(JSON.parse(p)); }
      catch(e2) {
        try { lista.push(JSON.parse(p.replace(/,\s*}/g, '}').replace(/:\s*([0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?)/g, function(m, n) { return ': ' + n.replace(/\./g, '').replace(',', '.'); }))); } catch(e3) {}
      }
    });
    lista = lista.filter(function(c) { return c && (c.importe || c.numero || c.banco); });
    if(!lista.length) throw new Error('La IA no devolvió datos legibles. Probá con una foto más nítida o con menos cheques');
    return lista;
  }
}


// ── Cola de actualización de planillas CC (espera unos segundos por si llegan varios avisos juntos) ──
var esperando = {};
function programar(terceroId) {
  if(!terceroId) return;
  if(esperando[terceroId]) clearTimeout(esperando[terceroId]);
  esperando[terceroId] = setTimeout(function() {
    delete esperando[terceroId];
    sincronizarCuenta(terceroId)
      .then(function(r) { if(!r.omitida) console.log('📗 Planilla actualizada:', r.cuenta, '(' + r.movimientos + ' movimientos)'); })
      .catch(function(e) { console.error('❌ Error sincronizando planilla', terceroId, e.message); });
  }, 6000);
}

async function sincronizarTodas() {
  var ters = chk(await sb().from('terceros').select('id,nombre').not('planilla_id', 'is', null));
  var ok = 0, errores = [];
  for(var i = 0; i < ters.length; i++) {
    try { await sincronizarCuenta(ters[i].id); ok++; }
    catch(e) { errores.push(ters[i].nombre + ': ' + e.message); }
    await new Promise(function(r) { setTimeout(r, 2500); }); // respeta el límite de Google
  }
  console.log('📗 Sincronización completa:', ok, 'planillas', errores.length ? '· errores: ' + errores.join(' | ') : '');
  return { actualizadas: ok, errores: errores };
}

module.exports = function(app) {
  app.post('/sync-planilla', express.json(), function(req, res) {
    if(req.get('x-sync-secret') !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    var b = req.body || {};
    programar(b.tercero_id);
    programar(b.destino_tercero_id);
    res.json({ ok: true });
  });
  // Aviso desde la app (con la sesión del usuario): actualiza las cuentas y/o cheques indicados
  app.post('/sync-cuenta', express.text({ type: 'text/plain', limit: '200kb' }), async function(req, res) {
    try {
      var b = JSON.parse(req.body || '{}');
      var u = await sb().auth.getUser(b.token || '');
      if(u.error || !u.data || !u.data.user) return res.status(401).json({ error: 'no autorizado' });
      (b.terceros || []).forEach(function(id) { programar(id); });
      if(b.cheques) programarCheques();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/sync-cheques', function(req, res) {
    if(req.get('x-sync-secret') !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    programarCheques();
    res.json({ ok: true });
  });
  app.get('/sync-cheques/ahora', function(req, res) {
    if(req.query.clave !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    sincronizarCheques().then(function(n) { res.json({ cheques: n }); }).catch(function(e) { res.status(500).json({ error: e.message }); });
  });
  // La app manda la foto como texto (JSON) para no chocar con el límite del parser general
  app.post('/leer-cheque', express.text({ type: 'text/plain', limit: '15mb' }), async function(req, res) {
    try {
      // el token va dentro del cuerpo: así el navegador no hace consulta previa de CORS
      var b = JSON.parse(req.body || '{}');
      var u = await sb().auth.getUser(b.token || '');
      if(u.error || !u.data || !u.data.user) return res.status(401).json({ error: 'Iniciá sesión en la app' });
      if(!b.imagen) return res.status(400).json({ error: 'Falta la foto' });
      var cheques = await leerCheques(b.imagen, b.mime);
      res.json({ ok: true, cheques: cheques });
    } catch(e) {
      console.error('❌ Leer cheque:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/sync-planilla/todas', function(req, res) {
    if(req.query.clave !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    sincronizarTodas().then(function(r) { res.json(r); }).catch(function(e) { res.status(500).json({ error: e.message }); });
  });
  setInterval(function() {
    sincronizarTodas().catch(function(e) { console.error('❌ Sync periódica:', e.message); });
    sincronizarCheques().catch(function(e) { console.error('❌ Sync cheques:', e.message); });
  }, 15 * 60 * 1000);
  console.log('📗 Sincronización de planillas CC activa');
};
