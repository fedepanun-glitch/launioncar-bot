// ============================================================
//  LA UNIÓN CAR SRL — Bot de WhatsApp
//  Servidor Node.js para Render.com
//  
//  INSTALACIÓN:
//  1. Crear cuenta en render.com
//  2. New Web Service → conectar este código
//  3. Configurar variables de entorno (ver abajo)
//  4. Conectar el webhook en Twilio
// ============================================================

const express = require(‘express’);
const { createClient } = require(’@supabase/supabase-js’);
const Anthropic = require(’@anthropic-ai/sdk’);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── VARIABLES DE ENTORNO ──────────────────────────────────
const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN      = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER  = process.env.TWILIO_WHATSAPP_NUMBER; // whatsapp:+14155238886
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;

const twilio    = require(‘twilio’)(TWILIO_SID, TWILIO_TOKEN);
const db        = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai        = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── MEMORIA DE CONVERSACIONES ─────────────────────────────
// Guardamos el historial de cada número de teléfono en memoria
// (se resetea al reiniciar el servidor - máx 20 mensajes por sesión)
const conversaciones = {};

// ── PROMPT DEL BOT ────────────────────────────────────────
const SYSTEM_PROMPT = `Sos el asistente de gestión de La Unión Car SRL, empresa argentina de transporte y venta de combustible.

Tu trabajo es interpretar mensajes en lenguaje natural (como los que se mandan por WhatsApp entre operadores) y convertirlos en acciones concretas sobre la base de datos.

CONTEXTO DE LA EMPRESA:

- Vende y transporta combustible: Gas Oil G2, Gas Oil Premium, Nafta Super, Infinia Diesel
- Tiene 6 camiones: UC-01 (Enrique Cefferino), UC-02 (Juan Benítez), UC-03 (Fernando Freire), UC-04 (Gustavo Fernández), UC-05 (Pablo Herrera), UC-06 (Juan Romero)
- Proveedores principales: Shell, YPF, Axion, Puma Energy, Copsa, Emanuel Derocchi
- Clientes: Petromas, Miguel Corrientes, Sampacho, Romero Carlos, Elisero, y muchos más
- Formas de cobro: efectivo, cheque, cheque electrónico (echeq), cuenta corriente, transferencia

CÓMO INTERPRETAR MENSAJES (ejemplos reales del grupo de WhatsApp):

- “Enrique cargó hoy 33.000 de sup a $1385 en Emanuel” → COMPRA: 33.000L nafta super a $1385/L en Emanuel Derocchi, camión UC-01
- “12.000 lts a Pedro, 18.000 a Petromas” → VENTAS múltiples
- “Llegó pago Petromas $52M cheques” → COBRO: $52.000.000 en cheques de Petromas
- “Pagamos a Copsa” + monto → PAGO A PROVEEDOR (gasto)
- “Enrique trajo de Marcelo $8M en ef” → COBRO: $8.000.000 efectivo, vendedor Marcelo
- “Fernando cargó sup 25.000 en Emanuel por $1385” → COMPRA
- “Miguel corrientes debe $33M al día de hoy” → CONSULTA de saldo

ACCIONES QUE PODÉS HACER:

1. registrar_venta - Registrar una venta de combustible
1. registrar_compra - Registrar una compra de combustible
1. registrar_cobro - Registrar un cobro de cliente
1. registrar_gasto - Registrar un gasto (pago a proveedor, reparación, etc.)
1. consultar_saldo - Consultar saldo de un cliente
1. consultar_stock - Consultar stock actual
1. consultar_ventas_hoy - Ver ventas del día
1. consultar_alertas - Ver vencimientos próximos
1. responder - Solo responder sin hacer nada en la base de datos

Cuando el mensaje no es claro, pedí confirmación antes de registrar.
Cuando registres algo, confirmá con un resumen claro de lo que hiciste.
Usá emojis para hacer la respuesta más legible.
Respondé siempre en español argentino informal (vos, dale, etc.).

Respondé SIEMPRE en este formato JSON (sin markdown, sin ):
{
“accion”: “nombre_de_la_accion”,
“datos”: { … datos relevantes … },
“mensaje”: “Mensaje de respuesta al usuario”
}

Para “responder” sin acción:
{
“accion”: “responder”,
“datos”: {},
“mensaje”: “Tu respuesta aquí”
}`;

// ── HELPERS ───────────────────────────────────────────────
function fmt$(n) {
return ‘$’ + Number(n).toLocaleString(‘es-AR’, {minimumFractionDigits: 0, maximumFractionDigits: 0});
}

function parseMonto(str) {
if (!str) return null;
// “52M” → 52000000, “$1.385” → 1385, “1385” → 1385
str = str.toString().trim().replace(/$/g, ‘’).replace(/./g, ‘’).replace(/,/g, ‘.’);
if (str.toUpperCase().endsWith(‘M’)) return parseFloat(str) * 1000000;
if (str.toUpperCase().endsWith(‘K’)) return parseFloat(str) * 1000;
return parseFloat(str);
}

function today() {
return new Date().toISOString().split(‘T’)[0];
}

async function buscarCliente(nombre) {
if (!nombre) return null;
const { data } = await db.from(‘clientes’).select(‘id,nombre’).ilike(‘nombre’, `%${nombre}%`).limit(1);
return data?.[0] || null;
}

async function buscarProveedor(nombre) {
if (!nombre) return null;
const { data } = await db.from(‘proveedores’).select(‘id,nombre’).ilike(‘nombre’, `%${nombre}%`).limit(1);
return data?.[0] || null;
}

async function buscarCamion(codigo) {
if (!codigo) return null;
const { data } = await db.from(‘camiones’).select(‘id,codigo’).ilike(‘codigo’, `%${codigo}%`).limit(1);
return data?.[0] || null;
}

function mapProducto(texto) {
if (!texto) return ‘gas_oil_g2’;
const t = texto.toLowerCase();
if (t.includes(‘sup’) || t.includes(‘super’)) return ‘nafta_super’;
if (t.includes(‘infinia’) || t.includes(‘inf’)) return ‘infinia_diesel’;
if (t.includes(‘premium’) || t.includes(‘prem’) || t.includes(‘500’) || t.includes(‘euro’)) return ‘gas_oil_premium’;
return ‘gas_oil_g2’; // gas oil por defecto
}

// ── EJECUTAR ACCIÓN EN LA BASE DE DATOS ──────────────────
async function ejecutarAccion(accion, datos) {
try {
switch (accion) {


  case 'registrar_venta': {
    const cliente = await buscarCliente(datos.cliente);
    const camion  = await buscarCamion(datos.camion);
    const producto = mapProducto(datos.producto);
    const litros = parseMonto(datos.litros);
    const precio = parseMonto(datos.precio_litro);

    if (!litros || !precio) return { ok: false, msg: 'Faltan litros o precio' };

    const { error } = await db.from('ventas').insert([{
      cliente_id: cliente?.id || null,
      camion_id: camion?.id || null,
      fecha: datos.fecha || today(),
      producto,
      litros,
      precio_litro_venta: precio,
      condicion_pago: datos.forma_pago || 'cuenta_corriente',
      estado_cobro: datos.forma_pago === 'efectivo' ? 'cobrado' : 'pendiente',
      observaciones: datos.notas || null
    }]);

    if (error) return { ok: false, msg: error.message };
    return {
      ok: true,
      msg: ✅ Venta registrada\n +
           📦 Cliente: ${cliente?.nombre || datos.cliente || 'Sin especificar'}\n +
           ⛽ ${litros.toLocaleString('es-AR')}L · $${precio.toLocaleString('es-AR')}/L\n +
           💰 Total: ${fmt$(litros * precio)}\n +
           🚛 Camión: ${camion?.codigo || datos.camion || '—'}
    };
  }

  case 'registrar_compra': {
    const proveedor = await buscarProveedor(datos.proveedor);
    const camion    = await buscarCamion(datos.camion);
    const producto  = mapProducto(datos.producto);
    const litros    = parseMonto(datos.litros);
    const precio    = parseMonto(datos.precio_litro);

    if (!litros || !precio) return { ok: false, msg: 'Faltan litros o precio' };

    const { error } = await db.from('compras').insert([{
      proveedor_id: proveedor?.id || null,
      fecha: datos.fecha || today(),
      producto,
      litros,
      precio_litro: precio,
      estado_pago: 'pagada',
      notas: datos.notas || null
    }]);

    if (error) return { ok: false, msg: error.message };
    return {
      ok: true,
      msg: ✅ Compra registrada\n +
           🏭 Proveedor: ${proveedor?.nombre || datos.proveedor || 'Sin especificar'}\n +
           ⛽ ${litros.toLocaleString('es-AR')}L · $${precio.toLocaleString('es-AR')}/L\n +
           💰 Total: ${fmt$(litros * precio)}\n +
           📦 Producto: ${producto.replace('_', ' ')}
    };
  }

  case 'registrar_cobro': {
    const cliente = await buscarCliente(datos.cliente);
    const monto   = parseMonto(datos.monto);

    if (!monto) return { ok: false, msg: 'Falta el monto' };

    const tipoCobro = datos.tipo || 'efectivo';
    const { error } = await db.from('cobranzas').insert([{
      cliente_id: cliente?.id || null,
      tipo: tipoCobro,
      monto,
      fecha_emision: today(),
      fecha_vencimiento: datos.fecha_vencimiento || null,
      nro_cheque: datos.nro_cheque || null,
      estado: tipoCobro === 'efectivo' || tipoCobro === 'transferencia' ? 'cobrado' : 'pendiente',
      notas: datos.notas || null
    }]);

    if (error) return { ok: false, msg: error.message };
    return {
      ok: true,
      msg: ✅ Cobro registrado\n +
           🏢 Cliente: ${cliente?.nombre || datos.cliente || 'Sin especificar'}\n +
           💰 Monto: ${fmt$(monto)}\n +
           💳 Tipo: ${tipoCobro}\n +
           ${datos.nro_cheque ? '🏦 Cheque N°: ' + datos.nro_cheque : ''}
    };
  }

  case 'registrar_gasto': {
    const camion = await buscarCamion(datos.camion);
    const monto  = parseMonto(datos.monto);

    if (!monto) return { ok: false, msg: 'Falta el monto' };

    // Si es pago a proveedor y no hay camión, igual lo registramos
    if (!camion && datos.camion) {
      return { ok: false, msg: No encontré el camión "${datos.camion}". ¿Podés especificar el código? (UC-01, UC-02, etc.) };
    }

    const { error } = await db.from('gastos_camiones').insert([{
      camion_id: camion?.id || null,
      fecha: today(),
      categoria: datos.categoria || 'otro',
      monto,
      descripcion: datos.descripcion || datos.notas || null,
      proveedor: datos.proveedor || null
    }]);

    if (error) return { ok: false, msg: error.message };
    return {
      ok: true,
      msg: ✅ Gasto registrado\n +
           🚛 Camión: ${camion?.codigo || 'Sin especificar'}\n +
           💸 Monto: ${fmt$(monto)}\n +
           📋 ${datos.descripcion || datos.categoria || 'Sin descripción'}
    };
  }

  case 'consultar_saldo': {
    const cliente = await buscarCliente(datos.cliente);
    if (!cliente) return { ok: false, msg: No encontré al cliente "${datos.cliente}" };

    const { data: ventas } = await db.from('ventas')
      .select('total_venta,estado_cobro')
      .eq('cliente_id', cliente.id);

    const { data: cobros } = await db.from('cobranzas')
      .select('monto,estado')
      .eq('cliente_id', cliente.id);

    const totalVentas = (ventas || []).reduce((s, v) => s + Number(v.total_venta), 0);
    const totalCobrado = (cobros || []).filter(c => c.estado === 'cobrado').reduce((s, c) => s + Number(c.monto), 0);
    const pendiente = totalVentas - totalCobrado;

    return {
      ok: true,
      msg: 📊 Estado de cuenta — ${cliente.nombre}\n +
           ━━━━━━━━━━━━━━━━━━\n +
           📦 Total vendido: ${fmt$(totalVentas)}\n +
           ✅ Total cobrado: ${fmt$(totalCobrado)}\n +
           ⚠️ Saldo pendiente: ${fmt$(Math.max(0, pendiente))}\n +
           ${pendiente > 0 ? '🔴 Debe dinero' : '🟢 Al día'}
    };
  }

  case 'consultar_stock': {
    const { data } = await db.from('stock_actual').select('*');
    if (!data || !data.length) return { ok: true, msg: '📦 Sin datos de stock aún. Registrá compras y ventas primero.' };

    const lineas = data.map(s => {
      const n = Number(s.litros_disponibles);
      const ico = n < 5000 ? '🔴' : n < 15000 ? '🟡' : '🟢';
      return ${ico} ${s.producto.replace(/_/g, ' ')}: ${n.toLocaleString('es-AR')} L;
    });

    return {
      ok: true,
      msg: 🛢️ Stock actual:\n━━━━━━━━━━━━━━━━━━\n${lineas.join('\n')}
    };
  }

  case 'consultar_ventas_hoy': {
    const { data } = await db.from('ventas')
      .select('*,clientes(nombre)')
      .eq('fecha', today())
      .order('created_at', { ascending: false });

    if (!data || !data.length) return { ok: true, msg: '📊 No hay ventas registradas hoy todavía.' };

    const total = data.reduce((s, v) => s + Number(v.total_venta), 0);
    const lineas = data.map(v =>
      • ${v.clientes?.nombre || '?'}: ${Number(v.litros).toLocaleString('es-AR')}L → ${fmt$(v.total_venta)}
    );

    return {
      ok: true,
      msg: ⛽ Ventas de hoy:\n━━━━━━━━━━━━━━━━━━\n${lineas.join('\n')}\n\n💰 Total del día: ${fmt$(total)}
    };
  }

  case 'consultar_alertas': {
    const { data } = await db.from('alertas_vencimientos')
      .select('*')
      .in('estado', ['vencido', 'urgente'])
      .order('dias_restantes', { ascending: true })
      .limit(10);

    if (!data || !data.length) return { ok: true, msg: '✅ No hay vencimientos urgentes. ¡Todo en orden!' };

    const lineas = data.map(a => {
      const ico = a.estado === 'vencido' ? '🚨' : '⚠️';
      const dias = a.dias_restantes < 0
        ? Vencido hace ${Math.abs(a.dias_restantes)} días
        : Vence en ${a.dias_restantes} días;
      return ${ico} ${a.entidad} — ${a.documento}\n   ${dias};
    });

    return {
      ok: true,
      msg: 🚨 Alertas de vencimientos:\n━━━━━━━━━━━━━━━━━━\n${lineas.join('\n\n')}
    };
  }

  default:
    return { ok: true, msg: null }; // Solo responde con mensaje de Claude
}


} catch (err) {
console.error(‘Error ejecutando acción:’, err);
return { ok: false, msg: ’Error interno: ’ + err.message };
}
}

// ── WEBHOOK PRINCIPAL ─────────────────────────────────────
app.post(’/webhook’, async (req, res) => {
const from    = req.body.From;   // whatsapp:+54911…
const body    = req.body.Body?.trim();
const mediaUrl = req.body.MediaUrl0; // foto adjunta

if (!body && !mediaUrl) {
return res.status(200).send(’<Response></Response>’);
}

console.log(`[${from}] ${body}`);

// Inicializar historial si no existe
if (!conversaciones[from]) conversaciones[from] = [];

// Agregar mensaje del usuario
conversaciones[from].push({ role: ‘user’, content: body || ‘[imagen adjunta]’ });

// Mantener máximo 20 mensajes de historial
if (conversaciones[from].length > 20) {
conversaciones[from] = conversaciones[from].slice(-20);
}

let respuesta = ‘Lo siento, no pude procesar el mensaje. Intentá de nuevo.’;

try {
// Llamar a Claude con historial completo
const response = await ai.messages.create({
model: ‘claude-sonnet-4-20250514’,
max_tokens: 1000,
system: SYSTEM_PROMPT,
messages: conversaciones[from]
});


const texto = response.content[0]?.text || '';
console.log('Claude responde:', texto);

// Parsear JSON de Claude
let parsed;
try {
  // Limpiar posibles markdown fences
  const clean = texto.replace(/json\n?/g, '').replace(/\n?/g, '').trim();
  parsed = JSON.parse(clean);
} catch {
  // Si no parsea, usar texto directo
  parsed = { accion: 'responder', datos: {}, mensaje: texto };
}

// Ejecutar acción en la base de datos
if (parsed.accion && parsed.accion !== 'responder') {
  const resultado = await ejecutarAccion(parsed.accion, parsed.datos || {});
  if (resultado.ok) {
    respuesta = resultado.msg || parsed.mensaje;
  } else {
    respuesta = ⚠️ ${resultado.msg}\n\n${parsed.mensaje || ''};
  }
} else {
  respuesta = parsed.mensaje || texto;
}

// Agregar respuesta del asistente al historial
conversaciones[from].push({ role: 'assistant', content: respuesta });
```

} catch (err) {
console.error(‘Error procesando mensaje:’, err);
respuesta = ‘⚠️ Error procesando el mensaje. Intentá en un momento.’;
}

// Enviar respuesta por WhatsApp
try {
await twilio.messages.create({
from: TWILIO_WA_NUMBER,
to: from,
body: respuesta
});
} catch (err) {
console.error(‘Error enviando mensaje Twilio:’, err);
}

res.status(200).send(’<Response></Response>’);
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get(’/’, (req, res) => {
res.json({ status: ‘ok’, app: ‘La Unión Car SRL Bot’, time: new Date().toISOString() });
});

// ── SERVER ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(Bot corriendo en puerto ${PORT}));
