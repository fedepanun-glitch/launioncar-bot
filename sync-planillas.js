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
  app.get('/sync-planilla/todas', function(req, res) {
    if(req.query.clave !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    sincronizarTodas().then(function(r) { res.json(r); }).catch(function(e) { res.status(500).json({ error: e.message }); });
  });
  setInterval(function() { sincronizarTodas().catch(function(e) { console.error('❌ Sync periódica:', e.message); }); }, 15 * 60 * 1000);
  console.log('📗 Sincronización de planillas CC activa');
};
