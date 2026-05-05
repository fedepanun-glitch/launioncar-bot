const express = require(‘express’);
const { createClient } = require(’@supabase/supabase-js’);
const Anthropic = require(’@anthropic-ai/sdk’);
const twilio = require(‘twilio’);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA = process.env.TWILIO_WHATSAPP_NUMBER;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new Anthropic({ apiKey: ANTHROPIC_KEY });

const historiales = {};

const SYSTEM = `Sos el asistente de La Union Car SRL, empresa argentina de transporte y venta de combustible.

Interpretas mensajes en lenguaje natural y los conviertes en acciones concretas.

CAMIONES Y CHOFERES:

- UC-01: Enrique Cefferino
- UC-02: Juan Benitez
- UC-03: Fernando Freire
- UC-04: Gustavo Fernandez
- UC-05: Pablo Herrera
- UC-06: Juan Romero

PROVEEDORES: Shell, YPF, Axion, Puma Energy, Copsa, Emanuel Derocchi

PRODUCTOS: gas_oil_g2, gas_oil_premium, nafta_super, infinia_diesel

EJEMPLOS DE MENSAJES:

- “Enrique cargo hoy 33000 de sup a 1385 en Emanuel” = compra de nafta super
- “12000 lts a Pedro, 18000 a Petromas” = ventas
- “Llego pago Petromas 52000000 cheques” = cobro
- “Pagamos a Copsa 10000000” = gasto/pago proveedor
- “Cuanto debe Miguel corrientes?” = consulta saldo
- “Stock?” = consulta stock

ACCIONES DISPONIBLES:

- registrar_venta
- registrar_compra
- registrar_cobro
- registrar_gasto
- consultar_saldo
- consultar_stock
- consultar_ventas_hoy
- consultar_alertas
- responder

Responde SIEMPRE en JSON puro sin markdown:
{“accion”:“nombre”,“datos”:{…},“mensaje”:“respuesta al usuario”}

Para consultas o cuando no hay accion:
{“accion”:“responder”,“datos”:{},“mensaje”:“tu respuesta”}

Usa lenguaje informal argentino. Respuestas cortas y con emojis.`;

function hoy() {
return new Date().toISOString().split(‘T’)[0];
}

function parseMonto(str) {
if (!str) return null;
var s = str.toString().replace(/$/g, ‘’).replace(/./g, ‘’).replace(/,/g, ‘.’).trim();
if (s.toUpperCase().endsWith(‘M’)) return parseFloat(s) * 1000000;
if (s.toUpperCase().endsWith(‘K’)) return parseFloat(s) * 1000;
return parseFloat(s);
}

function mapProducto(texto) {
if (!texto) return ‘gas_oil_g2’;
var t = texto.toLowerCase();
if (t.includes(‘sup’) || t.includes(‘super’)) return ‘nafta_super’;
if (t.includes(‘infinia’)) return ‘infinia_diesel’;
if (t.includes(‘premium’) || t.includes(‘prem’) || t.includes(‘euro’)) return ‘gas_oil_premium’;
return ‘gas_oil_g2’;
}

function formatPesos(n) {
return ‘$’ + Number(n).toLocaleString(‘es-AR’);
}

async function buscarCliente(nombre) {
if (!nombre) return null;
var res = await db.from(‘clientes’).select(‘id,nombre’).ilike(‘nombre’, ‘%’ + nombre + ‘%’).limit(1);
return res.data && res.data[0] ? res.data[0] : null;
}

async function buscarProveedor(nombre) {
if (!nombre) return null;
var res = await db.from(‘proveedores’).select(‘id,nombre’).ilike(‘nombre’, ‘%’ + nombre + ‘%’).limit(1);
return res.data && res.data[0] ? res.data[0] : null;
}

async function buscarCamion(codigo) {
if (!codigo) return null;
var res = await db.from(‘camiones’).select(‘id,codigo’).ilike(‘codigo’, ‘%’ + codigo + ‘%’).limit(1);
return res.data && res.data[0] ? res.data[0] : null;
}

async function ejecutar(accion, datos) {
try {
if (accion === ‘registrar_venta’) {
var cliente = await buscarCliente(datos.cliente);
var camion = await buscarCamion(datos.camion);
var litros = parseMonto(datos.litros);
var precio = parseMonto(datos.precio_litro);
if (!litros || !precio) return { ok: false, msg: ‘Faltan litros o precio’ };
var err = await db.from(‘ventas’).insert([{
cliente_id: cliente ? cliente.id : null,
camion_id: camion ? camion.id : null,
fecha: datos.fecha || hoy(),
producto: mapProducto(datos.producto),
litros: litros,
precio_litro_venta: precio,
condicion_pago: datos.forma_pago || ‘cuenta_corriente’,
estado_cobro: datos.forma_pago === ‘efectivo’ ? ‘cobrado’ : ‘pendiente’
}]);
if (err.error) return { ok: false, msg: err.error.message };
return { ok: true, msg: ’Venta registrada\nCliente: ’ + (cliente ? cliente.nombre : datos.cliente || ‘?’) + ’\nLitros: ’ + litros.toLocaleString(‘es-AR’) + ‘\nPrecio: $’ + precio.toLocaleString(‘es-AR’) + ’/L\nTotal: ’ + formatPesos(litros * precio) };
}

```
if (accion === 'registrar_compra') {
  var proveedor = await buscarProveedor(datos.proveedor);
  var litros = parseMonto(datos.litros);
  var precio = parseMonto(datos.precio_litro);
  if (!litros || !precio) return { ok: false, msg: 'Faltan litros o precio' };
  var err = await db.from('compras').insert([{
    proveedor_id: proveedor ? proveedor.id : null,
    fecha: datos.fecha || hoy(),
    producto: mapProducto(datos.producto),
    litros: litros,
    precio_litro: precio,
    estado_pago: 'pagada'
  }]);
  if (err.error) return { ok: false, msg: err.error.message };
  return { ok: true, msg: 'Compra registrada\nProveedor: ' + (proveedor ? proveedor.nombre : datos.proveedor || '?') + '\nLitros: ' + litros.toLocaleString('es-AR') + '\nTotal: ' + formatPesos(litros * precio) };
}

if (accion === 'registrar_cobro') {
  var cliente = await buscarCliente(datos.cliente);
  var monto = parseMonto(datos.monto);
  if (!monto) return { ok: false, msg: 'Falta el monto' };
  var tipo = datos.tipo || 'efectivo';
  var err = await db.from('cobranzas').insert([{
    cliente_id: cliente ? cliente.id : null,
    tipo: tipo,
    monto: monto,
    fecha_emision: hoy(),
    estado: tipo === 'efectivo' || tipo === 'transferencia' ? 'cobrado' : 'pendiente'
  }]);
  if (err.error) return { ok: false, msg: err.error.message };
  return { ok: true, msg: 'Cobro registrado\nCliente: ' + (cliente ? cliente.nombre : datos.cliente || '?') + '\nMonto: ' + formatPesos(monto) + '\nTipo: ' + tipo };
}

if (accion === 'registrar_gasto') {
  var camion = await buscarCamion(datos.camion);
  var monto = parseMonto(datos.monto);
  if (!monto) return { ok: false, msg: 'Falta el monto' };
  var err = await db.from('gastos_camiones').insert([{
    camion_id: camion ? camion.id : null,
    fecha: hoy(),
    categoria: datos.categoria || 'otro',
    monto: monto,
    descripcion: datos.descripcion || null,
    proveedor: datos.proveedor || null
  }]);
  if (err.error) return { ok: false, msg: err.error.message };
  return { ok: true, msg: 'Gasto registrado\nMonto: ' + formatPesos(monto) + '\n' + (datos.descripcion || '') };
}

if (accion === 'consultar_saldo') {
  var cliente = await buscarCliente(datos.cliente);
  if (!cliente) return { ok: false, msg: 'No encontre al cliente "' + datos.cliente + '"' };
  var vRes = await db.from('ventas').select('total_venta').eq('cliente_id', cliente.id);
  var cRes = await db.from('cobranzas').select('monto,estado').eq('cliente_id', cliente.id);
  var totalV = (vRes.data || []).reduce(function(s, v) { return s + Number(v.total_venta); }, 0);
  var totalC = (cRes.data || []).filter(function(c) { return c.estado === 'cobrado'; }).reduce(function(s, c) { return s + Number(c.monto); }, 0);
  var pendiente = totalV - totalC;
  return { ok: true, msg: 'Estado de cuenta - ' + cliente.nombre + '\nTotal vendido: ' + formatPesos(totalV) + '\nTotal cobrado: ' + formatPesos(totalC) + '\nSaldo pendiente: ' + formatPesos(Math.max(0, pendiente)) + (pendiente > 0 ? '\nDebe dinero' : '\nAl dia') };
}

if (accion === 'consultar_stock') {
  var sRes = await db.from('stock_actual').select('*');
  if (!sRes.data || !sRes.data.length) return { ok: true, msg: 'Sin datos de stock aun' };
  var lineas = sRes.data.map(function(s) {
    var n = Number(s.litros_disponibles);
    var ico = n < 5000 ? 'BAJO' : n < 15000 ? 'MEDIO' : 'OK';
    return s.producto.replace(/_/g, ' ') + ': ' + n.toLocaleString('es-AR') + ' L [' + ico + ']';
  });
  return { ok: true, msg: 'Stock actual:\n' + lineas.join('\n') };
}

if (accion === 'consultar_ventas_hoy') {
  var vRes = await db.from('ventas').select('*,clientes(nombre)').eq('fecha', hoy());
  if (!vRes.data || !vRes.data.length) return { ok: true, msg: 'No hay ventas registradas hoy' };
  var total = vRes.data.reduce(function(s, v) { return s + Number(v.total_venta); }, 0);
  var lineas = vRes.data.map(function(v) { return (v.clientes ? v.clientes.nombre : '?') + ': ' + Number(v.litros).toLocaleString('es-AR') + 'L = ' + formatPesos(v.total_venta); });
  return { ok: true, msg: 'Ventas de hoy:\n' + lineas.join('\n') + '\n\nTotal: ' + formatPesos(total) };
}

if (accion === 'consultar_alertas') {
  var aRes = await db.from('alertas_vencimientos').select('*').in('estado', ['vencido', 'urgente']).order('dias_restantes', { ascending: true }).limit(10);
  if (!aRes.data || !aRes.data.length) return { ok: true, msg: 'No hay vencimientos urgentes. Todo en orden!' };
  var lineas = aRes.data.map(function(a) {
    var estado = a.dias_restantes < 0 ? 'VENCIDO hace ' + Math.abs(a.dias_restantes) + ' dias' : 'Vence en ' + a.dias_restantes + ' dias';
    return a.entidad + ' - ' + a.documento + ': ' + estado;
  });
  return { ok: true, msg: 'Alertas de vencimientos:\n' + lineas.join('\n') };
}

return { ok: true, msg: null };
```

} catch (e) {
console.error(‘Error en accion:’, e);
return { ok: false, msg: ’Error: ’ + e.message };
}
}

app.post(’/webhook’, async function(req, res) {
var from = req.body.From;
var body = req.body.Body ? req.body.Body.trim() : ‘’;

if (!body) {
return res.status(200).send(’<Response></Response>’);
}

console.log(’Mensaje de ’ + from + ’: ’ + body);

if (!historiales[from]) historiales[from] = [];
historiales[from].push({ role: ‘user’, content: body });
if (historiales[from].length > 16) {
historiales[from] = historiales[from].slice(-16);
}

var respuesta = ‘Lo siento, no pude procesar el mensaje.’;

try {
var response = await ai.messages.create({
model: ‘claude-sonnet-4-20250514’,
max_tokens: 800,
system: SYSTEM,
messages: historiales[from]
});

```
var texto = response.content[0] ? response.content[0].text : '';
console.log('Claude responde:', texto);

var parsed;
try {
  var clean = texto.replace(/```json/g, '').replace(/```/g, '').trim();
  parsed = JSON.parse(clean);
} catch (e) {
  parsed = { accion: 'responder', datos: {}, mensaje: texto };
}

if (parsed.accion && parsed.accion !== 'responder') {
  var resultado = await ejecutar(parsed.accion, parsed.datos || {});
  if (resultado.ok) {
    respuesta = resultado.msg || parsed.mensaje || 'Listo!';
  } else {
    respuesta = 'Error: ' + resultado.msg;
  }
} else {
  respuesta = parsed.mensaje || texto;
}

historiales[from].push({ role: 'assistant', content: respuesta });
```

} catch (e) {
console.error(‘Error procesando:’, e);
respuesta = ‘Error procesando el mensaje. Intenta de nuevo.’;
}

try {
await twilioClient.messages.create({
from: TWILIO_WA,
to: from,
body: respuesta
});
} catch (e) {
console.error(‘Error Twilio:’, e);
}

res.status(200).send(’<Response></Response>’);
});

app.get(’/’, function(req, res) {
res.json({ status: ‘ok’, app: ‘La Union Car Bot’ });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
console.log(’Bot corriendo en puerto ’ + PORT);
});