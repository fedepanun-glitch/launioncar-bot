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


// ── Creación de planillas nuevas mediante el Apps Script (corre con la cuenta de Google de la empresa) ──
function pedirAppsScript(cuerpo) {
  var url = process.env.APPS_SCRIPT_URL;
  if(!url) return Promise.reject(new Error('Falta APPS_SCRIPT_URL en Render'));
  var https = require('https');
  var datos = JSON.stringify(Object.assign({ clave: process.env.SYNC_SECRET }, cuerpo));
  var pedir = function(u, metodo, saltos) {
    return new Promise(function(ok, mal) {
      var x = new URL(u);
      var req = https.request({ hostname: x.hostname, path: x.pathname + x.search, method: metodo,
        headers: metodo === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) } : {} }, function(res) {
        if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && saltos < 5) { res.resume(); return ok(pedir(res.headers.location, 'GET', saltos + 1)); }
        var t = ''; res.on('data', function(c) { t += c; }); res.on('end', function() {
          try { var j = JSON.parse(t); if(!j.ok) return mal(new Error(j.error || 'El Apps Script no pudo crear la planilla')); ok(j); }
          catch(e) { mal(new Error('Respuesta inesperada del Apps Script (' + res.statusCode + ')')); }
        });
      });
      req.on('error', mal);
      if(metodo === 'POST') req.write(datos);
      req.end();
    });
  };
  return pedir(url, 'POST', 0);
}
var CARPETAS_PLANILLAS = { cc: '12OlZk5lxNJAlV8ulFK5GcZAI8aC6bsWB', chofer: '1x0rPWhMGX3u8TP6o7hdHCNCpwVeVav_q', camion: '1lODvg0eJp6dUyZqFnBpISgYee54zncP-' };
function tituloPlanilla(cuerpo) { return cuerpo.tipo === 'cc' ? 'CC ' + cuerpo.nombre : (cuerpo.tipo === 'chofer' ? 'Chofer - ' + cuerpo.nombre : 'Camión ' + cuerpo.nombre); }
// Busca si ya hay una planilla con ese nombre en la carpeta (para no crear duplicados)
async function buscarPlanillaExistente(cuerpo) {
  try {
    var cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    var auth = new google.auth.JWT(cred.client_email, null, cred.private_key, ['https://www.googleapis.com/auth/drive.readonly']);
    var drive = google.drive({ version: 'v3', auth: auth });
    var nombre = tituloPlanilla(cuerpo).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var r = await drive.files.list({ q: "'" + CARPETAS_PLANILLAS[cuerpo.tipo] + "' in parents and name = '" + nombre + "' and trashed = false",
      orderBy: 'modifiedTime desc', fields: 'files(id,name)', pageSize: 5 });
    return (r.data.files || [])[0] ? r.data.files[0].id : null;
  } catch(e) { console.error('⚠️ No pude buscar planillas existentes:', e.message); return null; }
}
async function crearPlanilla(tabla, id, cuerpo) {
  var planillaId = await buscarPlanillaExistente(cuerpo);
  if(planillaId) console.log('♻️ Ya existía la planilla, la reutilizo:', tituloPlanilla(cuerpo));
  else { planillaId = (await pedirAppsScript(cuerpo)).id; console.log('🆕 Planilla creada en Drive:', tituloPlanilla(cuerpo)); }
  var up = await sb().from(tabla).update({ planilla_id: planillaId }).eq('id', id).select('id');
  if(up.error || !up.data || !up.data.length) {
    var msg = 'No pude anotar la planilla en la tabla ' + tabla + ': ' + (up.error ? up.error.message : 'no se actualizó ningún registro');
    console.error('❌ ' + msg);
    _erroresPlanillas.push(tituloPlanilla(cuerpo) + ' → ' + msg);
  }
  return planillaId;
}
var _erroresPlanillas = [];

async function sincronizarCuenta(terceroId) {
  var ter = chk(await sb().from('terceros').select('nombre,planilla_id,es_cliente,es_proveedor').eq('id', terceroId));
  if(!ter.length) return { omitida: true };
  if(!ter[0].planilla_id) {
    // cuenta sin planilla: se crea solo si tiene movimientos desde el 01/10 y está configurado el Apps Script
    if(!process.env.APPS_SCRIPT_URL) return { omitida: true };
    var recientes = chk(await sb().from('movimientos_cuenta').select('id').eq('tercero_id', terceroId).gte('fecha', FECHA_INICIO).limit(1));
    if(!recientes.length) return { omitida: true };
    ter[0].planilla_id = await crearPlanilla('terceros', terceroId, { tipo: 'cc', nombre: ter[0].nombre,
      tipoCuenta: ter[0].es_proveedor && !ter[0].es_cliente ? 'Proveedor' : (ter[0].es_cliente && ter[0].es_proveedor ? 'Cliente y proveedor' : 'Cliente') });
  }
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
  // saldo inicial = todo lo anterior al 01/10 (incluye correcciones por conciliación)
  var previos = chk(await sb().from('movimientos_cuenta').select('importe').eq('tercero_id', terceroId).lt('fecha', FECHA_INICIO));
  var saldoInicial = Math.round(previos.reduce(function(s, m) { return s + Number(m.importe || 0); }, 0) * 100) / 100;
  var sh = sheetsCliente();
  var id = ter[0].planilla_id;
  await sh.spreadsheets.values.batchClear({ spreadsheetId: id, requestBody: { ranges: ['Cuenta!A10:G1000', 'Cuenta!I10:L1000'] } });
  await sh.spreadsheets.values.update({ spreadsheetId: id, range: 'Cuenta!A9:H9', valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['01/10/2026', 'Saldo inicial', 'Saldo al 30/09/2026 (según la app, incluye conciliaciones)', '', '', '', '', saldoInicial]] } });
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
  if(process.env.APPS_SCRIPT_URL) {
    // cuentas nuevas con movimientos desde el 01/10 que todavía no tienen planilla
    var conMovs = chk(await sb().from('movimientos_cuenta').select('tercero_id').gte('fecha', FECHA_INICIO));
    var ya = {}; ters.forEach(function(t) { ya[t.id] = 1; });
    var sinPlanilla = chk(await sb().from('terceros').select('id,nombre').is('planilla_id', null));
    var nuevos = {}; conMovs.forEach(function(m) { nuevos[m.tercero_id] = 1; });
    sinPlanilla.forEach(function(t) { if(nuevos[t.id] && !ya[t.id]) ters.push(t); });
  }
  var ok = 0, errores = [];
  for(var i = 0; i < ters.length; i++) {
    try { await sincronizarCuenta(ters[i].id); ok++; }
    catch(e) { errores.push(ters[i].nombre + ': ' + e.message); }
    await new Promise(function(r) { setTimeout(r, 2500); }); // respeta el límite de Google
  }
  errores = errores.concat(_erroresPlanillas.splice(0));
  console.log('📗 Sincronización completa:', ok, 'planillas', errores.length ? '· errores: ' + errores.join(' | ') : '');
  return { actualizadas: ok, errores: errores };
}


// ── PLANILLA "CAMIONES Y CHOFERES" ───────────────────────────────────
var FLOTA_SHEET = process.env.FLOTA_SHEET_ID || '1eVe1b4JBT3lGPcp5Gad8b8eo5N0ksqKsQbD4eaqJnPA';

// ── Arma una hoja con formato a partir de filas "con estilo" ──
// cada fila: { v: [valores], t: 'titulo' | 'sub' | 'seccion' | 'cab' | 'mes' | 'total' | null }
function armarFormato(sheetId, filas, anchos, colsPesos) {
  var req = [{ repeatCell: { range: { sheetId: sheetId }, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat' } }];
  var ncol = anchos.length;
  var rango = function(r) { return { sheetId: sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: ncol }; };
  var color = function(r, g, b) { return { red: r, green: g, blue: b }; };
  filas.forEach(function(f, r) {
    if(f.t === 'titulo') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 15 } } }, fields: 'userEnteredFormat.textFormat' } });
    if(f.t === 'sub') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { textFormat: { italic: true, foregroundColor: color(0.4, 0.4, 0.4) } } }, fields: 'userEnteredFormat.textFormat' } });
    if(f.t === 'seccion') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12, foregroundColor: color(0.12, 0.22, 0.39) } } }, fields: 'userEnteredFormat.textFormat' } });
    if(f.t === 'cab') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { backgroundColor: color(0.12, 0.22, 0.39), textFormat: { bold: true, foregroundColor: color(1, 1, 1) }, wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)' } });
    if(f.t === 'mes') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { backgroundColor: color(0.86, 0.9, 0.96), textFormat: { bold: true, fontSize: 11 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
    if(f.t === 'total') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { backgroundColor: color(0.95, 0.95, 0.95), textFormat: { bold: true }, borders: { top: { style: 'SOLID' } } } }, fields: 'userEnteredFormat(backgroundColor,textFormat,borders)' } });
    if(f.t === 'pendiente') req.push({ repeatCell: { range: rango(r), cell: { userEnteredFormat: { backgroundColor: color(1, 0.95, 0.8) } }, fields: 'userEnteredFormat.backgroundColor' } });
  });
  colsPesos.forEach(function(c) {
    req.push({ repeatCell: { range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: filas.length, startColumnIndex: c, endColumnIndex: c + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00;-"$"#,##0.00;""' }, horizontalAlignment: 'RIGHT' } }, fields: 'userEnteredFormat(numberFormat,horizontalAlignment)' } });
  });
  anchos.forEach(function(w, c) { req.push({ updateDimensionProperties: { range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } }); });
  return req;
}

// Escribe una hoja (la primera del archivo, o la pestaña indicada) con sus valores y formato
async function escribirHoja(sh, spreadsheetId, filas, anchos, colsPesos, titulo) {
  var info = await sh.spreadsheets.get({ spreadsheetId: spreadsheetId, fields: 'properties.locale,sheets.properties(sheetId,title)' });
  var hojas = info.data.sheets || [], hoja = null, pre = [];
  if(titulo) {
    hoja = hojas.filter(function(x) { return x.properties.title === titulo; })[0];
    if(!hoja) {
      var add = await sh.spreadsheets.batchUpdate({ spreadsheetId: spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] } });
      hoja = { properties: add.data.replies[0].addSheet.properties };
    }
  } else {
    hoja = hojas[0];
    if(hoja.properties.title !== 'Cuenta') pre.push({ updateSheetProperties: { properties: { sheetId: hoja.properties.sheetId, title: 'Cuenta' }, fields: 'title' } });
  }
  if(info.data.properties.locale !== 'es_AR') pre.push({ updateSpreadsheetProperties: { properties: { locale: 'es_AR', timeZone: 'America/Argentina/Buenos_Aires' }, fields: 'locale,timeZone' } });
  var nombre = titulo || 'Cuenta';
  await sh.spreadsheets.values.clear({ spreadsheetId: spreadsheetId, range: "'" + (pre.length && !titulo ? hoja.properties.title : nombre) + "'!A1:Z5000" });
  var req = pre.concat(armarFormato(hoja.properties.sheetId, filas, anchos, colsPesos));
  await sh.spreadsheets.batchUpdate({ spreadsheetId: spreadsheetId, requestBody: { requests: req } });
  await sh.spreadsheets.values.update({ spreadsheetId: spreadsheetId, range: "'" + nombre + "'!A1", valueInputOption: 'USER_ENTERED',
    requestBody: { values: filas.map(function(f) { return f.v; }) } });
  return hoja.properties.sheetId;
}

var CATS = ['combustible', 'neumaticos', 'reparacion', 'repuestos', 'lubricantes', 'peaje', 'limpieza', 'otro'];
var CAT_NOM = { combustible: 'Combustible', neumaticos: 'Neumáticos', reparacion: 'Reparación', repuestos: 'Repuestos', lubricantes: 'Lubricantes', peaje: 'Peaje', limpieza: 'Limpieza', otro: 'Otro',
  adelanto_sueldo: 'Adelanto', viatico: 'Viático', comida: 'Comida', documentacion: 'Documentación' };
var MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function nomMes(k) { return MESES[Number(k.slice(5, 7))] + ' ' + k.slice(0, 4); }
function ahoraAR() { var d = new Date(Date.now() - 3 * 3600 * 1000); return d.toISOString().slice(8, 10) + '/' + d.toISOString().slice(5, 7) + '/' + d.toISOString().slice(0, 4) + ' ' + d.toISOString().slice(11, 16); }
var ESTADO_SUELDO = { pagado: 'Liquidado y pagado', pendiente: 'Liquidado, falta pagar', calculado: 'Calculado' };

function filasChofer(ch, nombre, camion, ents, gastos, sueldos) {
  var meses = {};
  var m = function(k) { return meses[k] = meses[k] || { ent: [], gas: [], adel$: 0, pago$: 0, gas$: 0, sueldo: null, estado: null }; };
  ents.forEach(function(e) { var x = m(e.periodo || e.fecha.slice(0, 7)); x.ent.push(e); if(e.categoria === 'pago_sueldo') x.pago$ += Number(e.monto); else x.adel$ += Number(e.monto); });
  gastos.forEach(function(g) { var x = m(g.fecha.slice(0, 7)); x.gas.push(g); x.gas$ += Number(g.monto); });
  sueldos.forEach(function(s) { var x = m(s.anio + '-' + ('0' + s.mes).slice(-2)); x.sueldo = Number(s.total_bruto || s.total_neto || 0); x.estado = s.estado; });
  var claves = Object.keys(meses).sort().reverse();
  var falta = function(x) { return x.sueldo === null ? '' : Math.round((x.sueldo - x.adel$ + x.gas$ - x.pago$) * 100) / 100; };
  var F = [];
  F.push({ v: ['Cuenta del chofer: ' + nombre], t: 'titulo' });
  F.push({ v: ['Camión: ' + (camion || 'sin asignar') + '  ·  Actualizado ' + ahoraAR() + '  ·  Se completa sola desde la app: no editar acá'], t: 'sub' });
  F.push({ v: [] });
  F.push({ v: ['RESUMEN POR MES DE SUELDO (para liquidar)'], t: 'seccion' });
  F.push({ v: ['Mes del sueldo', 'Adelantos', 'Gastos que pagó el chofer (se le devuelven)', 'Sueldo liquidado', 'Pagos de sueldo', 'Falta pagarle', 'Estado'], t: 'cab' });
  claves.forEach(function(k) {
    var x = meses[k], f = falta(x);
    var estado = x.sueldo === null ? 'Sin liquidar' : (Math.abs(f) < 1 ? 'Pagado completo' : (f > 0 ? 'Falta pagar' : 'Se le pagó de más'));
    F.push({ v: [nomMes(k), x.adel$, x.gas$, x.sueldo === null ? '' : x.sueldo, x.pago$, f, estado], t: x.sueldo === null || Math.abs(f) >= 1 ? 'pendiente' : null });
  });
  F.push({ v: ['Falta pagarle = sueldo liquidado − adelantos + gastos que pagó − pagos de sueldo. Cada entrega cuenta en el mes del sueldo al que corresponde (aunque se haya pagado en otro mes).'], t: 'sub' });
  F.push({ v: [] });
  F.push({ v: ['DETALLE POR MES DE SUELDO'], t: 'seccion' });
  claves.forEach(function(k) {
    var x = meses[k];
    F.push({ v: [nomMes(k).toUpperCase()], t: 'mes' });
    F.push({ v: ['Fecha', 'Movimiento', 'Categoría', 'Detalle', 'Entregado al chofer', 'Gasto que pagó'], t: 'cab' });
    var movs = x.ent.map(function(e) {
      var otroMes = e.periodo && e.periodo !== e.fecha.slice(0, 7);
      return [e.fecha, e.categoria === 'pago_sueldo' ? 'Pago de sueldo' : 'Entrega', CAT_NOM[e.categoria] || (e.categoria === 'pago_sueldo' ? 'Pago de sueldo' : e.categoria || ''), (e.descripcion || '') + (otroMes ? ' (pagado en ' + nomMes(e.fecha.slice(0, 7)).toLowerCase() + ')' : ''), Number(e.monto), ''];
    }).concat(x.gas.map(function(g) { return [g.fecha, 'Gasto', CAT_NOM[g.categoria] || g.categoria || '', g.descripcion || '', '', Number(g.monto)]; }));
    movs.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    movs.forEach(function(r) { r[0] = fechaAR(r[0]); F.push({ v: r }); });
    F.push({ v: ['Total ' + nomMes(k).toLowerCase(), '', '', '', x.adel$ + x.pago$, x.gas$], t: 'total' });
    if(x.sueldo !== null) F.push({ v: ['Sueldo liquidado: $ ' + x.sueldo.toLocaleString('es-AR') + '   →   falta pagarle: $ ' + Number(falta(x)).toLocaleString('es-AR')], t: 'sub' });
    F.push({ v: [] });
  });
  if(!claves.length) F.push({ v: ['Todavía no hay movimientos cargados.'] });
  return F;
}

function filasCamion(c, chofer, gastos) {
  var meses = {};
  gastos.forEach(function(g) { var k = g.fecha.slice(0, 7); var x = meses[k] = meses[k] || { lista: [], cats: {}, total: 0 }; x.lista.push(g);
    var cat = CATS.indexOf(g.categoria) >= 0 ? g.categoria : 'otro'; x.cats[cat] = (x.cats[cat] || 0) + Number(g.monto); x.total += Number(g.monto); });
  var claves = Object.keys(meses).sort().reverse();
  var F = [];
  F.push({ v: ['Camión ' + c.codigo + (c.patente ? ' · ' + c.patente : '')], t: 'titulo' });
  F.push({ v: ['Chofer actual: ' + (chofer || 'sin asignar') + '  ·  Actualizado ' + ahoraAR() + '  ·  Se completa sola desde la app: no editar acá'], t: 'sub' });
  F.push({ v: [] });
  F.push({ v: ['RESUMEN DE GASTOS POR MES'], t: 'seccion' });
  F.push({ v: ['Mes'].concat(CATS.map(function(k) { return CAT_NOM[k]; })).concat(['Total del mes']), t: 'cab' });
  claves.forEach(function(k) { var x = meses[k]; F.push({ v: [nomMes(k)].concat(CATS.map(function(cat) { return x.cats[cat] || ''; })).concat([x.total]) }); });
  F.push({ v: [] });
  F.push({ v: ['DETALLE POR MES'], t: 'seccion' });
  claves.forEach(function(k) {
    var x = meses[k];
    F.push({ v: [nomMes(k).toUpperCase()], t: 'mes' });
    F.push({ v: ['Fecha', 'Categoría', 'Descripción', 'Proveedor / taller', 'Chofer', 'Monto'], t: 'cab' });
    x.lista.sort(function(a, b) { return a.fecha < b.fecha ? -1 : 1; }).forEach(function(g) {
      F.push({ v: [fechaAR(g.fecha), CAT_NOM[g.categoria] || g.categoria || '', g.descripcion || '', g.proveedor || '', g._chofer || '', Number(g.monto)] });
    });
    F.push({ v: ['Total ' + nomMes(k).toLowerCase(), '', '', '', '', x.total], t: 'total' });
    F.push({ v: [] });
  });
  if(!claves.length) F.push({ v: ['Todavía no hay gastos cargados para este camión.'] });
  return F;
}

async function sincronizarFlota() {
  var r = await Promise.all([
    sb().from('camiones').select('id,codigo,patente,chofer_id,planilla_id').order('codigo'),
    sb().from('choferes').select('id,nombre,apellido,planilla_id').order('apellido'),
    sb().from('gastos_camiones').select('camion_id,chofer_id,fecha,categoria,monto,descripcion,proveedor').order('fecha'),
    sb().from('entregas_choferes').select('chofer_id,fecha,categoria,monto,descripcion,periodo').order('fecha'),
    sb().from('sueldos_choferes').select('chofer_id,mes,anio,total_neto,total_bruto,estado')
  ]);
  var cams = chk(r[0]), chofs = chk(r[1]), gastos = chk(r[2]), ents = chk(r[3]), sueldos = chk(r[4]);
  var nomCh = {}; chofs.forEach(function(c) { nomCh[c.id] = ((c.nombre || '') + ' ' + (c.apellido || '')).replace(/\s+/g, ' ').trim(); });
  var camDeCh = {}; cams.forEach(function(c) { if(c.chofer_id) camDeCh[c.chofer_id] = c.id; });
  var codCam = {}; cams.forEach(function(c) { codCam[c.id] = c.codigo; });
  gastos.forEach(function(g) { g._cam = g.camion_id || camDeCh[g.chofer_id] || null; g._chofer = nomCh[g.chofer_id] || ''; });
  var sh = sheetsCliente(), hechas = 0, errores = [];
  var pausa = function() { return new Promise(function(ok) { setTimeout(ok, 1500); }); };
  // 1) un archivo por chofer
  for(var i = 0; i < chofs.length; i++) {
    var ch = chofs[i];
    if(!ch.planilla_id) {
      if(!process.env.APPS_SCRIPT_URL) continue;
      try { ch.planilla_id = await crearPlanilla('choferes', ch.id, { tipo: 'chofer', nombre: nomCh[ch.id] }); }
      catch(e) { errores.push(nomCh[ch.id] + ': ' + e.message); continue; }
    }
    try {
      var F = filasChofer(ch, nomCh[ch.id], codCam[camDeCh[ch.id]], ents.filter(function(e) { return e.chofer_id === ch.id; }), gastos.filter(function(g) { return g.chofer_id === ch.id; }), sueldos.filter(function(s) { return s.chofer_id === ch.id; }));
      await escribirHoja(sh, ch.planilla_id, F, [170, 130, 170, 140, 140, 140, 140], [1, 2, 3, 4, 5]);
      hechas++;
    } catch(e) { errores.push(nomCh[ch.id] + ': ' + e.message); }
    await pausa();
  }
  // 2) un archivo por camión
  for(var j = 0; j < cams.length; j++) {
    var c = cams[j];
    if(!c.planilla_id) {
      if(!process.env.APPS_SCRIPT_URL) continue;
      try { c.planilla_id = await crearPlanilla('camiones', c.id, { tipo: 'camion', nombre: c.codigo }); }
      catch(e) { errores.push(c.codigo + ': ' + e.message); continue; }
    }
    try {
      await escribirHoja(sh, c.planilla_id, filasCamion(c, nomCh[c.chofer_id], gastos.filter(function(g) { return g._cam === c.id; })), [150, 110, 110, 110, 110, 110, 110, 110, 110, 130], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      hechas++;
    } catch(e) { errores.push(c.codigo + ': ' + e.message); }
    await pausa();
  }
  // 3) tablero general: todos los choferes y todos los camiones por mes
  var RC = [{ v: ['Choferes: resumen por mes'], t: 'titulo' }, { v: ['Actualizado ' + ahoraAR() + ' · el detalle de cada uno está en la carpeta "Choferes"'], t: 'sub' }, { v: [] },
            { v: ['Chofer', 'Mes del sueldo', 'Adelantos', 'Gastos que pagó', 'Sueldo liquidado', 'Pagos de sueldo', 'Falta pagarle'], t: 'cab' }];
  chofs.forEach(function(ch) {
    var meses = {};
    var m = function(k) { return meses[k] = meses[k] || { a: 0, p: 0, g: 0, s: null }; };
    ents.forEach(function(e) { if(e.chofer_id !== ch.id) return; var x = m(e.periodo || e.fecha.slice(0, 7)); if(e.categoria === 'pago_sueldo') x.p += Number(e.monto); else x.a += Number(e.monto); });
    gastos.forEach(function(g) { if(g.chofer_id === ch.id) m(g.fecha.slice(0, 7)).g += Number(g.monto); });
    sueldos.forEach(function(s) { if(s.chofer_id === ch.id) m(s.anio + '-' + ('0' + s.mes).slice(-2)).s = Number(s.total_bruto || s.total_neto || 0); });
    Object.keys(meses).sort().reverse().slice(0, 6).forEach(function(k) { var x = meses[k]; var f = x.s === null ? 'Sin liquidar' : Math.round((x.s - x.a + x.g - x.p) * 100) / 100;
      RC.push({ v: [nomCh[ch.id], nomMes(k), x.a, x.g, x.s === null ? '' : x.s, x.p, f], t: x.s === null || Math.abs(f) >= 1 ? 'pendiente' : null }); });
  });
  var RK = [{ v: ['Camiones: gastos por mes'], t: 'titulo' }, { v: ['Actualizado ' + ahoraAR() + ' · el detalle de cada uno está en la carpeta "Camiones"'], t: 'sub' }, { v: [] },
            { v: ['Camión', 'Mes'].concat(CATS.map(function(k) { return CAT_NOM[k]; })).concat(['Total']), t: 'cab' }];
  cams.forEach(function(c) {
    var meses = {};
    gastos.forEach(function(g) { if(g._cam !== c.id) return; var k = g.fecha.slice(0, 7); var x = meses[k] = meses[k] || { cats: {}, t: 0 }; var cat = CATS.indexOf(g.categoria) >= 0 ? g.categoria : 'otro'; x.cats[cat] = (x.cats[cat] || 0) + Number(g.monto); x.t += Number(g.monto); });
    Object.keys(meses).sort().reverse().slice(0, 6).forEach(function(k) { var x = meses[k]; RK.push({ v: [c.codigo, nomMes(k)].concat(CATS.map(function(cat) { return x.cats[cat] || ''; })).concat([x.t]) }); });
  });
  try {
    await escribirHoja(sh, FLOTA_SHEET, RC, [190, 130, 140, 140, 140, 140, 140], [2, 3, 4, 5, 6], 'Resumen choferes');
    await escribirHoja(sh, FLOTA_SHEET, RK, [90, 130, 110, 110, 110, 110, 110, 110, 110, 110, 120], [2, 3, 4, 5, 6, 7, 8, 9, 10], 'Resumen camiones');
    // sacar las pestañas viejas (una por chofer/camión) que ahora están en archivos separados
    var info = await sh.spreadsheets.get({ spreadsheetId: FLOTA_SHEET, fields: 'sheets.properties(sheetId,title)' });
    var borrar = (info.data.sheets || []).filter(function(x) { return ['Resumen choferes', 'Resumen camiones'].indexOf(x.properties.title) < 0; });
    if(borrar.length) await sh.spreadsheets.batchUpdate({ spreadsheetId: FLOTA_SHEET, requestBody: { requests: borrar.map(function(x) { return { deleteSheet: { sheetId: x.properties.sheetId } }; }) } });
  } catch(e) { errores.push('Tablero general: ' + e.message); }
  errores = errores.concat(_erroresPlanillas.splice(0));
  return { archivos_actualizados: hechas, errores: errores };
}

var esperandoFlota = null;
function programarFlota() {
  if(esperandoFlota) clearTimeout(esperandoFlota);
  esperandoFlota = setTimeout(function() {
    esperandoFlota = null;
    sincronizarFlota().then(function(r) { console.log('📗 Planilla de camiones y choferes actualizada', JSON.stringify(r)); })
      .catch(function(e) { console.error('❌ Error planilla de camiones y choferes:', e.message); });
  }, 8000);
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
      if(b.flota) programarFlota();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/sync-flota', function(req, res) {
    if(req.get('x-sync-secret') !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    programarFlota();
    res.json({ ok: true });
  });
  app.get('/apps-script/probar', function(req, res) {
    if(req.query.clave !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    if(!process.env.APPS_SCRIPT_URL) return res.json({ ok: false, error: 'Falta APPS_SCRIPT_URL en Render' });
    var https = require('https'), u = new URL(process.env.APPS_SCRIPT_URL), saltos = 0;
    (function get(url) { https.get(url, function(r) { if(r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && saltos++ < 5) { r.resume(); return get(r.headers.location); }
      var t = ''; r.on('data', function(c) { t += c; }); r.on('end', function() { res.type('json').send(t); }); }).on('error', function(e) { res.json({ ok: false, error: e.message }); }); })(u.href);
  });
  app.get('/sync-flota/ahora', function(req, res) {
    if(req.query.clave !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    sincronizarFlota().then(function(r) { res.json(r); }).catch(function(e) { res.status(500).json({ error: e.message }); });
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
    sincronizarFlota().catch(function(e) { console.error('❌ Sync camiones y choferes:', e.message); });
  }, 15 * 60 * 1000);
  console.log('📗 Sincronización de planillas CC activa');
};

module.exports.programarFlota = programarFlota;
