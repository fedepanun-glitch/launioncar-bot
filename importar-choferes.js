// =====================================================================
// IMPORTAR PLANILLAS DE CHOFERES (desde copias en "Planillas de la app")
//   /importar-choferes?clave=SYNC_SECRET&simular=1   -> muestra qué cargaría
//   /importar-choferes?clave=SYNC_SECRET             -> carga todo
//   &solo=luis                                        -> un solo chofer
// "$ para él" -> entregas_choferes  ·  gastos -> gastos_camiones
// Reemplaza lo que la app tenía de ese chofer en las fechas de la planilla
// (no toca las entregas que vienen de un pago de cliente cargado en la app).
// =====================================================================
var { google } = require('googleapis');
var XLSX = require('xlsx');
var supabaseLib = require('@supabase/supabase-js');
var _sb = null;
function sb() { if(!_sb) _sb = supabaseLib.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY); return _sb; }
function chk(r) { if(r.error) throw new Error(r.error.message); return r.data || []; }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim(); }

var PLANILLAS = [
  { clave: 'luis',     archivo: '1JsXHOo1Phgmo7eOmtBMjQ-YTE3F_vMtl', buscar: 'banosola' },
  { clave: 'gustavo',  archivo: '1Ph5XHkI14wDB4i2e6nIqreG05VaxWrQf', buscar: 'gustavo' },
  { clave: 'fernando', archivo: '1Oq_3NXN-M8cnIgtA7E-twjUnvKL7EjvN', buscar: 'freire' },
  { clave: 'enrique',  archivo: '1mN-7YdLd66sxhldA6KWuGcDvB__Onj85', buscar: 'cefferino' },
  { clave: 'juan',     archivo: '1N2I1GWTRo5X3xWNMNp4PUi7Gb-z8UpQO', buscar: 'benitez' },
  { clave: 'nahuel',   archivo: '12NR1toG4YfO1U3zoChNlC4aPm2191JiR', buscar: 'burgos' },
  { clave: 'samuel',   archivo: '1OUL_1spoDghZJGSkwajQq9yLEyAPFXaI', buscar: 'samuel' },
  { clave: 'lalo',     archivo: '1zJGCacdxXkkFllZ1wsIjkD1O1zhryYZm', buscar: 'lalo', nuevo: { nombre: 'Lalo', apellido: '-' } },
  { clave: 'silvio',   archivo: '1SfiQM2CmX6ZL5l2n6uMGNu_Vci00z8PfSr0pSnnuksA', buscar: 'silvio', nuevo: { nombre: 'Silvio', apellido: 'Hidalgo' } }
];

// ── Lectura de números y fechas como vienen en las planillas ──
function num(v) {
  if(v === null || v === undefined || v === '') return null;
  if(typeof v === 'number') return isNaN(v) ? null : v;
  var s = String(v).replace(/\$/g, '').replace(/\s/g, '').replace(/\u00a0/g, '');
  if(!s) return null;
  var neg = false;
  if(/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if(s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  var uc = s.lastIndexOf(','), up = s.lastIndexOf('.');
  if(uc >= 0 && up >= 0) { if(up > uc) s = s.replace(/,/g, ''); else s = s.replace(/\./g, '').replace(',', '.'); }
  else if(uc >= 0) { s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'); }
  else if(up >= 0) { if(/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); }
  var n = parseFloat(s);
  if(isNaN(n)) return null;
  return neg ? -n : n;
}
function fecha(v) {
  if(v === null || v === undefined || v === '') return null;
  var d = null;
  if(v instanceof Date) d = new Date(v.getFullYear(), v.getMonth(), v.getDate());
  else if(typeof v === 'number') {
    if(v < 40000 || v > 60000) return null;
    var u = new Date(Math.round((v - 25569) * 86400000)); d = new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
  } else {
    var m = String(v).trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if(!m) return null;
    var dd = +m[1], mm = +m[2], yy = +m[3]; if(yy < 100) yy += 2000;
    if(mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    d = new Date(yy, mm - 1, dd);
  }
  if(!d || isNaN(d.getTime())) return null;
  var y = d.getFullYear(); if(y < 2024 || y > 2026) return null;
  return y + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function catEntrega(t) {
  t = norm(t);
  if(/peaje/.test(t)) return 'peaje';
  if(/viatico/.test(t)) return 'viatico';
  if(/comida|almuerzo|cena/.test(t)) return 'comida';
  if(/combust|gasoil|gas oil|nafta/.test(t)) return 'combustible';
  if(/registro|medico|psicof|carnet|licencia/.test(t)) return 'documentacion';
  return 'adelanto_sueldo';
}
function catGasto(t, litros) {
  t = norm(t);
  if(litros || /combust|gasoil|gas oil|nafta|\bgo\b/.test(t)) return 'combustible';
  if(/gom|cubiert|neumat|llanta/.test(t)) return 'neumaticos';
  if(/aceite|lubric|filtro/.test(t)) return 'lubricantes';
  if(/repuesto|kit|carrocer|bater|fuelle/.test(t)) return 'repuestos';
  if(/lavad|limpieza/.test(t)) return 'limpieza';
  if(/peaje/.test(t)) return 'peaje';
  if(/reparac|mecan|taller|electric|soldad|arreglo/.test(t)) return 'reparacion';
  return 'otro';
}
var COLS_CATEGORIA = [[/lavader/, 'limpieza'], [/repuesto/, 'repuestos'], [/taller/, 'reparacion'], [/gomer/, 'neumaticos']];

// ── Lee todos los bloques "Fecha | ..." de una hoja ──
function leerHoja(aoa) {
  var out = [];
  for(var r = 0; r < aoa.length; r++) {
    var fila = aoa[r] || [];
    for(var c = 0; c < fila.length; c++) {
      if(!/^\s*fecha\s*$/i.test(String(fila[c] == null ? '' : fila[c]))) continue;
      var col = { para: -1, gasto: -1, litros: -1, precio: -1, nota: -1, cats: [] }, fin = c + 1;
      for(var k = c + 1; k < c + 9; k++) {
        var t = norm(fila[k]);
        if(/^fecha/.test(t)) break;
        fin = k + 1;
        if(k === c + 1 && t === '') { col.para = k; continue; }
        var esCat = null; COLS_CATEGORIA.forEach(function(x) { if(x[0].test(t)) esCat = x[1]; });
        if(esCat) { col.cats.push([k, esCat]); continue; }
        if(/para\s*(el)?|entreg|adelant/.test(t) && col.para < 0) col.para = k;
        else if(/gasto/.test(t) && col.gasto < 0) col.gasto = k;
        else if(/litro/.test(t) && col.litros < 0) col.litros = k;
        else if(/valor|precio/.test(t) && col.precio < 0) col.precio = k;
        else if(/coment|detalle|nota|observ|descrip/.test(t) && col.nota < 0) col.nota = k;
      }
      if(col.para < 0 && col.gasto < 0 && !col.cats.length) continue;
      var vacias = 0;
      for(var rr = r + 1; rr < aoa.length; rr++) {
        var f = aoa[rr] || [];
        if(/^\s*fecha\s*$/i.test(String(f[c] == null ? '' : f[c]))) break;
        var fe = fecha(f[c]);
        var tieneAlgo = false; for(var q = c; q < fin + 2; q++) if(f[q] !== null && f[q] !== undefined && f[q] !== '') tieneAlgo = true;
        if(!tieneAlgo) { vacias++; if(vacias >= 3) break; continue; }
        vacias = 0;
        if(!fe) continue;
        var nota = col.nota >= 0 && f[col.nota] ? String(f[col.nota]).trim() : '';
        if(!nota) for(var z = c + 1; z < fin + 2; z++) { if(typeof f[z] === 'string' && f[z].trim() && num(f[z]) === null && !fecha(f[z])) { nota = f[z].trim(); break; } }
        var litros = col.litros >= 0 ? num(f[col.litros]) : null;
        var precio = col.precio >= 0 ? num(f[col.precio]) : null;
        if(litros && litros > 5000) litros = null;
        var para = col.para >= 0 ? num(f[col.para]) : null;
        var gasto = col.gasto >= 0 ? num(f[col.gasto]) : null;
        if(para && para > 0) out.push({ clase: 'entrega', fecha: fe, monto: Math.abs(para), categoria: catEntrega(nota), nota: nota });
        if(gasto && gasto > 0) out.push({ clase: 'gasto', fecha: fe, monto: Math.abs(gasto), categoria: catGasto(nota, litros), nota: nota + (litros ? (nota ? ' · ' : '') + litros + ' L' + (precio ? ' a $' + precio : '') : '') });
        col.cats.forEach(function(x) { var v = num(f[x[0]]); if(v && v > 0) out.push({ clase: 'gasto', fecha: fe, monto: v, categoria: x[1], nota: nota }); });
      }
    }
  }
  return out;
}

// Junta todas las hojas sin duplicar lo que aparece repetido en dos hojas
function leerLibro(wb) {
  var total = [], visto = {};
  wb.SheetNames.forEach(function(n) {
    var aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: true });
    var hoja = leerHoja(aoa), cuenta = {};
    hoja.forEach(function(o) {
      var k = o.clase + '|' + o.fecha + '|' + o.monto;
      cuenta[k] = (cuenta[k] || 0) + 1;
      if(cuenta[k] > (visto[k] || 0)) total.push(o);
    });
    Object.keys(cuenta).forEach(function(k) { visto[k] = Math.max(visto[k] || 0, cuenta[k]); });
  });
  total.sort(function(a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });
  return total;
}

async function descargar(fileId) {
  var cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  var auth = new google.auth.JWT(cred.client_email, null, cred.private_key, ['https://www.googleapis.com/auth/drive.readonly']);
  var drive = google.drive({ version: 'v3', auth: auth });
  var meta = await drive.files.get({ fileId: fileId, fields: 'mimeType,name' });
  var res = meta.data.mimeType === 'application/vnd.google-apps.spreadsheet'
    ? await drive.files.export({ fileId: fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { responseType: 'arraybuffer' })
    : await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return XLSX.read(Buffer.from(res.data), { type: 'buffer', cellDates: true });
}

async function importarUno(p, simular) {
  var movs = leerLibro(await descargar(p.archivo));
  var chofs = chk(await sb().from('choferes').select('id,nombre,apellido'));
  var ch = chofs.filter(function(c) { return norm((c.nombre || '') + ' ' + (c.apellido || '')).indexOf(norm(p.buscar)) >= 0; });
  var res = { planilla: p.clave, movimientos: movs.length };
  if(ch.length > 1) { res.error = 'Hay varios choferes que coinciden con "' + p.buscar + '"'; return res; }
  var choferId = ch.length ? ch[0].id : null;
  res.chofer = ch.length ? ((ch[0].nombre || '') + ' ' + (ch[0].apellido || '')).trim() : (p.nuevo ? 'NUEVO: ' + p.nuevo.nombre + ' ' + p.nuevo.apellido : 'NO ENCONTRADO');
  if(!choferId && !p.nuevo) { res.error = 'No encontré el chofer en la app'; return res; }
  var ent = movs.filter(function(o) { return o.clase === 'entrega'; }), gas = movs.filter(function(o) { return o.clase === 'gasto'; });
  var suma = function(a) { return Math.round(a.reduce(function(s, o) { return s + o.monto; }, 0) * 100) / 100; };
  res.entregas = ent.length; res.total_entregas = suma(ent); res.gastos = gas.length; res.total_gastos = suma(gas);
  res.desde = movs.length ? movs[0].fecha : null; res.hasta = movs.length ? movs[movs.length - 1].fecha : null;
  var porMes = {}; movs.forEach(function(o) { var m = o.fecha.slice(0, 7); porMes[m] = porMes[m] || { entregas: 0, gastos: 0 }; porMes[m][o.clase === 'entrega' ? 'entregas' : 'gastos'] += o.monto; });
  res.por_mes = porMes;
  if(simular || !movs.length) { res.ejemplos = movs.slice(-6); return res; }
  if(!choferId) { var rn = chk(await sb().from('choferes').insert([p.nuevo]).select()); choferId = rn[0].id; }
  var cam = chk(await sb().from('camiones').select('id').eq('chofer_id', choferId))[0];
  var fuente = 'planilla ' + p.clave + ' (Drive)';
  chk(await sb().from('entregas_choferes').delete().eq('chofer_id', choferId).gte('fecha', res.desde).lte('fecha', res.hasta).is('operacion_id', null).select('id'));
  chk(await sb().from('gastos_camiones').delete().eq('chofer_id', choferId).gte('fecha', res.desde).lte('fecha', res.hasta).select('id'));
  if(ent.length) chk(await sb().from('entregas_choferes').insert(ent.map(function(o) { return { chofer_id: choferId, fecha: o.fecha, categoria: o.categoria, monto: o.monto, descripcion: o.nota || null, fuente: fuente }; })).select('id'));
  if(gas.length) chk(await sb().from('gastos_camiones').insert(gas.map(function(o) { return { chofer_id: choferId, camion_id: cam ? cam.id : null, fecha: o.fecha, categoria: o.categoria, monto: o.monto, descripcion: o.nota || null, fuente: fuente }; })).select('id'));
  res.importado = true;
  return res;
}

module.exports = function(app, alTerminar) {
  app.get('/importar-choferes', async function(req, res) {
    if(req.query.clave !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'no autorizado' });
    var simular = !!req.query.simular, solo = req.query.solo ? norm(req.query.solo) : null, salida = [];
    for(var i = 0; i < PLANILLAS.length; i++) {
      var p = PLANILLAS[i];
      if(solo && p.clave !== solo) continue;
      try { salida.push(await importarUno(p, simular)); }
      catch(e) { salida.push({ planilla: p.clave, error: e.message }); }
    }
    if(!simular && typeof alTerminar === 'function') alTerminar();
    res.json({ modo: simular ? 'SIMULACIÓN (no se cargó nada)' : 'IMPORTADO', resultados: salida });
  });
  console.log('📄 Importador de planillas de choferes activo');
};
module.exports._leerLibro = leerLibro;
module.exports._leerHoja = leerHoja;
