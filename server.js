require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { calcularValor } = require('./tarifa');

// ---------- Configuración ----------
const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'ADMIN_USER', 'ADMIN_PASS', 'OPERADOR_USER', 'OPERADOR_PASS'];
for (const k of REQUERIDAS) {
  if (!process.env[k]) {
    console.error(`Falta la variable de entorno ${k}. Revise su archivo .env (o Environment en Render).`);
    process.exit(1);
  }
}
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET, ADMIN_USER, ADMIN_PASS, OPERADOR_USER, OPERADOR_PASS } = process.env;
const PORT = process.env.PORT || 3000;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilidades ----------
// Colombia es UTC-5 todo el año (no hay horario de verano)
const ZONA = 'America/Bogota';
const fechaBogota = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: ZONA }); // YYYY-MM-DD
const inicioDia = (f) => new Date(`${f}T00:00:00-05:00`).toISOString();
const finDia = (f) => new Date(new Date(`${f}T00:00:00-05:00`).getTime() + 86400000).toISOString();
const esFecha = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');

const limpiarPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
function detectarTipo(placa) {
  if (/^[A-Z]{3}\d{3}$/.test(placa)) return 'carro';      // ABC123
  if (/^[A-Z]{3}\d{2}[A-Z]?$/.test(placa)) return 'moto'; // ABC12D o ABC12
  return null;
}
const entero = (v) => Math.max(0, Math.round(Number(v) || 0));
const errorUsuario = (msg, status = 400) => Object.assign(new Error(msg), { status });
// "Camioneta Grande" -> "camioneta-grande" (identificador interno del tipo)
const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

// Envuelve rutas async para que los errores lleguen al manejador final
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Supabase devuelve máximo 1000 filas por consulta: esto trae todas por páginas
async function traerTodo(consulta) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await consulta().range(desde, desde + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

async function obtenerTarifa(tipo) {
  const { data, error } = await db.from('tarifas').select('*').eq('tipo', tipo).maybeSingle();
  if (error) throw error;
  if (!data) throw errorUsuario(`No existe tarifa para el tipo "${tipo}"`);
  return data;
}

async function tiposActivos() {
  const { data, error } = await db.from('tarifas').select('tipo').eq('activo', true);
  if (error) throw error;
  return data.map((t) => t.tipo);
}

async function liquidar(registro) {
  const tarifa = await obtenerTarifa(registro.tipo);
  const salida = new Date();
  const minutos = Math.max(0, Math.floor((salida - new Date(registro.entrada)) / 60000));
  return { salida: salida.toISOString(), minutos, valor: calcularValor(minutos, tarifa) };
}

// ---------- Sesión ----------
function auth(rol) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    try {
      const usuario = jwt.verify(token, JWT_SECRET);
      if (rol === 'admin' && usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede hacer esto' });
      req.usuario = usuario;
      next();
    } catch {
      res.status(401).json({ error: 'Sesión vencida, ingrese de nuevo' });
    }
  };
}

app.post('/api/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  let rol = null;
  if (usuario === ADMIN_USER && clave === ADMIN_PASS) rol = 'admin';
  else if (usuario === OPERADOR_USER && clave === OPERADOR_PASS) rol = 'operador';
  if (!rol) return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  const token = jwt.sign({ usuario, rol }, JWT_SECRET, { expiresIn: '16h' });
  res.json({ token, rol });
});

// Para UptimeRobot: mantiene despierto Render y también Supabase
app.get('/health', wrap(async (req, res) => {
  const { error } = await db.from('configuracion').select('id').limit(1);
  if (error) return res.status(500).send('db error');
  res.send('ok');
}));

// ---------- Caja (operador y admin) ----------
app.get('/api/config', auth(), wrap(async (req, res) => {
  const [{ data: config, error: e1 }, { data: tarifas, error: e2 }] = await Promise.all([
    db.from('configuracion').select('*').eq('id', 1).single(),
    db.from('tarifas').select('*').order('orden').order('nombre'),
  ]);
  if (e1 || e2) throw e1 || e2;
  res.json({ config, tarifas });
}));

app.post('/api/entrada', auth(), wrap(async (req, res) => {
  const placa = limpiarPlaca(req.body.placa);
  if (placa.length < 2) return res.status(400).json({ error: 'Escriba la placa o identificación del vehículo' });

  // ¿Es mensualidad vigente? Entonces no se imprime recibo
  const { data: mens } = await db.from('mensualidades').select('*').eq('placa', placa).maybeSingle();
  let aviso = '';
  if (mens && mens.activo) {
    if (mens.fecha_fin >= fechaBogota()) return res.json({ mensualidad: mens });
    aviso = `La mensualidad de ${placa} está vencida desde ${mens.fecha_fin}. Se registra como visitante.`;
  }

  const activos = await tiposActivos();
  const detectado = detectarTipo(placa);
  const tipo = activos.includes(req.body.tipo) ? req.body.tipo : (activos.includes(detectado) ? detectado : null);
  if (!tipo) return res.status(400).json({ error: 'Seleccione el tipo de vehículo' });

  const { data: yaDentro } = await db.from('registros').select('entrada').eq('placa', placa).eq('estado', 'dentro').maybeSingle();
  if (yaDentro) return res.status(409).json({ error: `La placa ${placa} ya está registrada dentro del parqueadero` });

  const { data, error } = await db.from('registros').insert({ placa, tipo }).select().single();
  if (error) throw error;
  res.json({ registro: data, aviso });
}));

app.post('/api/salida/consultar', auth(), wrap(async (req, res) => {
  const placa = limpiarPlaca(req.body.placa);
  const { data: registro } = await db.from('registros').select('*').eq('placa', placa).eq('estado', 'dentro').maybeSingle();
  if (!registro) {
    const { data: mens } = await db.from('mensualidades').select('id').eq('placa', placa).maybeSingle();
    const extra = mens ? ' Es una mensualidad: márquela en la pestaña Mensualidades.' : '';
    return res.status(404).json({ error: `No hay ningún vehículo con placa ${placa} dentro.${extra}` });
  }
  res.json({ registro, ...(await liquidar(registro)) });
}));

app.post('/api/salida/confirmar', auth(), wrap(async (req, res) => {
  const id = Number(req.body.id);
  const { data: registro } = await db.from('registros').select('*').eq('id', id).eq('estado', 'dentro').maybeSingle();
  if (!registro) return res.status(404).json({ error: 'Este vehículo ya había salido' });
  const l = await liquidar(registro);
  const { data, error } = await db.from('registros')
    .update({ salida: l.salida, minutos: l.minutos, valor: l.valor, estado: 'salio' })
    .eq('id', id).eq('estado', 'dentro').select().single();
  if (error) throw error;
  res.json({ registro: data });
}));

app.get('/api/dentro', auth(), wrap(async (req, res) => {
  const { data, error } = await db.from('registros').select('*').eq('estado', 'dentro').order('entrada');
  if (error) throw error;
  res.json({ registros: data });
}));

// ---------- Mensualidades (caja) ----------
app.get('/api/mensualidades', auth(), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const [{ data: lista, error: e1 }, { data: movimientos, error: e2 }] = await Promise.all([
    db.from('mensualidades').select('*').order('placa'),
    db.from('movimientos_mensualidad').select('*').gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).order('fecha', { ascending: false }),
  ]);
  if (e1 || e2) throw e1 || e2;
  res.json({ mensualidades: lista.map((m) => ({ ...m, vencida: m.fecha_fin < hoy })), movimientosHoy: movimientos });
}));

app.post('/api/mensualidades/:id/movimiento', auth(), wrap(async (req, res) => {
  const movimiento = req.body.movimiento;
  if (!['entrada', 'salida'].includes(movimiento)) return res.status(400).json({ error: 'Movimiento inválido' });
  const { data: m } = await db.from('mensualidades').select('*').eq('id', Number(req.params.id)).maybeSingle();
  if (!m) return res.status(404).json({ error: 'Mensualidad no encontrada' });

  const entra = movimiento === 'entrada';
  if (entra && m.dentro) return res.status(409).json({ error: `${m.placa} ya está dentro. Primero debe marcar la salida.` });
  if (!entra && !m.dentro) return res.status(409).json({ error: `${m.placa} no ha entrado. No se puede marcar salida.` });
  if (entra && !m.activo) return res.status(409).json({ error: `La mensualidad de ${m.placa} está inactiva.` });
  if (entra && m.fecha_fin < fechaBogota()) return res.status(409).json({ error: `La mensualidad de ${m.placa} venció el ${m.fecha_fin}. Regístrela como visitante o renuévela.` });

  // Cambia el estado solo si sigue como estaba (evita doble clic o dos cajas al tiempo)
  const { data: cambio, error: e1 } = await db.from('mensualidades')
    .update({ dentro: entra }).eq('id', m.id).eq('dentro', !entra).select('id');
  if (e1) throw e1;
  if (!cambio.length) return res.status(409).json({ error: `El estado de ${m.placa} acaba de cambiar. Actualice la lista.` });

  const { error: e2 } = await db.from('movimientos_mensualidad').insert({ mensualidad_id: m.id, placa: m.placa, tipo: m.tipo, movimiento });
  if (e2) throw e2;
  res.json({ ok: true });
}));

// ---------- Cierre de caja ----------
// "Pendiente" = cobros ya hechos que todavía no se han entregado en un cierre
const pendientesCierre = () => traerTodo(() => db.from('registros')
  .select('id,placa,tipo,valor,salida').eq('estado', 'salio').is('cierre_id', null).order('id'));

// Agrupa cobros por tipo: { detalle: { moto: { n, valor } }, cantidad, total_sistema, desde, hasta }
function resumirCobros(regs) {
  const r = { detalle: {}, cantidad: 0, total_sistema: 0, desde: null, hasta: null };
  for (const x of regs) {
    const v = x.valor || 0;
    const d = (r.detalle[x.tipo] ??= { n: 0, valor: 0 });
    d.n++; d.valor += v;
    r.cantidad++; r.total_sistema += v;
    if (!r.desde || new Date(x.salida) < new Date(r.desde)) r.desde = x.salida;
    if (!r.hasta || new Date(x.salida) > new Date(r.hasta)) r.hasta = x.salida;
  }
  return r;
}

async function entradasMensualidadHoy() {
  const hoy = fechaBogota();
  const { count, error } = await db.from('movimientos_mensualidad').select('id', { count: 'exact', head: true })
    .eq('movimiento', 'entrada').gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy));
  if (error) throw error;
  return count || 0;
}

app.get('/api/caja/resumen', auth(), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const [regs, mens, { data: cierresHoy, error }] = await Promise.all([
    pendientesCierre(),
    entradasMensualidadHoy(),
    db.from('cierres_caja').select('*').gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).order('fecha', { ascending: false }),
  ]);
  if (error) throw error;
  res.json({ pendiente: { ...resumirCobros(regs), mens_entradas: mens }, cierresHoy });
}));

app.post('/api/caja/cierre', auth(), wrap(async (req, res) => {
  const regs = await pendientesCierre();
  if (!regs.length) return res.status(400).json({ error: 'No hay cobros pendientes por cerrar' });

  const r = resumirCobros(regs);
  const contado = entero(req.body.efectivo_contado);
  const { data: cierre, error } = await db.from('cierres_caja').insert({
    ...r,
    usuario: req.usuario.usuario,
    efectivo_contado: contado,
    diferencia: contado - r.total_sistema,
    mens_entradas: await entradasMensualidadHoy(),
    observaciones: String(req.body.observaciones || '').slice(0, 300),
  }).select().single();
  if (error) throw error;

  // Amarra exactamente los cobros contados a este cierre (de a 200 para no hacer URLs largas)
  const ids = regs.map((x) => x.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { error: e } = await db.from('registros').update({ cierre_id: cierre.id }).in('id', ids.slice(i, i + 200));
    if (e) throw e;
  }
  res.json({ cierre });
}));

// ---------- Administrador: tipos de vehículo y tarifas ----------
function datosTarifa(t) {
  return {
    nombre: String(t.nombre || '').trim().slice(0, 40),
    valor_hora: entero(t.valor_hora),
    minutos_gracia: entero(t.minutos_gracia),
    tope_dia: entero(t.tope_dia),
    activo: t.activo !== false,
    orden: entero(t.orden),
    actualizado: new Date().toISOString(),
  };
}

app.put('/api/admin/tarifas', auth('admin'), wrap(async (req, res) => {
  const tarifas = Array.isArray(req.body.tarifas) ? req.body.tarifas : [];
  for (const t of tarifas) {
    const datos = datosTarifa(t);
    if (!datos.nombre) throw errorUsuario('Todos los tipos deben tener nombre');
    const { error } = await db.from('tarifas').update(datos).eq('tipo', String(t.tipo));
    if (error) throw error;
  }
  res.json({ ok: true });
}));

app.post('/api/admin/tipos', auth('admin'), wrap(async (req, res) => {
  const datos = datosTarifa(req.body);
  const tipo = slug(datos.nombre);
  if (!tipo) throw errorUsuario('Escriba el nombre del tipo (ej: Bicicleta)');
  if (!datos.orden) datos.orden = 99;
  const { data, error } = await db.from('tarifas').insert({ tipo, ...datos }).select().single();
  if (error) {
    if (error.code === '23505') throw errorUsuario(`Ya existe un tipo llamado "${datos.nombre}"`, 409);
    throw error;
  }
  res.json({ tarifa: data });
}));

// ---------- Administrador: datos del recibo ----------
app.put('/api/admin/config', auth('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const cambios = {
    nombre: String(b.nombre || 'PARQUEADERO').slice(0, 60),
    nit: String(b.nit || '').slice(0, 40),
    direccion: String(b.direccion || '').slice(0, 80),
    telefono: String(b.telefono || '').slice(0, 40),
    mensaje: String(b.mensaje || '').slice(0, 300),
    ancho_papel: b.ancho_papel === '80' ? '80' : '58',
  };
  const { error } = await db.from('configuracion').update(cambios).eq('id', 1);
  if (error) throw error;
  res.json({ ok: true });
}));

// ---------- Administrador: mensualidades ----------
async function datosMensualidad(b) {
  const placa = limpiarPlaca(b.placa);
  if (placa.length < 2) throw errorUsuario('Escriba una placa válida');
  const { data: tarifa } = await db.from('tarifas').select('tipo').eq('tipo', String(b.tipo)).maybeSingle();
  if (!tarifa) throw errorUsuario('Seleccione el tipo de vehículo');
  if (!esFecha(b.fecha_fin)) throw errorUsuario('Escriba la fecha de vencimiento');
  return {
    placa,
    tipo: tarifa.tipo,
    propietario: String(b.propietario || '').slice(0, 80),
    telefono: String(b.telefono || '').slice(0, 40),
    valor: entero(b.valor),
    fecha_inicio: esFecha(b.fecha_inicio) ? b.fecha_inicio : fechaBogota(),
    fecha_fin: b.fecha_fin,
    activo: b.activo !== false,
  };
}

app.post('/api/admin/mensualidades', auth('admin'), wrap(async (req, res) => {
  const { data, error } = await db.from('mensualidades').insert(await datosMensualidad(req.body)).select().single();
  if (error) throw error;
  res.json({ mensualidad: data });
}));

app.put('/api/admin/mensualidades/:id', auth('admin'), wrap(async (req, res) => {
  const { data, error } = await db.from('mensualidades').update(await datosMensualidad(req.body)).eq('id', Number(req.params.id)).select().single();
  if (error) throw error;
  res.json({ mensualidad: data });
}));

app.delete('/api/admin/mensualidades/:id', auth('admin'), wrap(async (req, res) => {
  const { error } = await db.from('mensualidades').delete().eq('id', Number(req.params.id));
  if (error) throw error;
  res.json({ ok: true });
}));

// ---------- Administrador: cierres de caja ----------
app.get('/api/admin/cierres', auth('admin'), wrap(async (req, res) => {
  let q = db.from('cierres_caja').select('*').order('fecha', { ascending: false }).limit(200);
  if (req.query.pendientes === '1') q = q.eq('revisado', false);
  if (esFecha(req.query.desde)) q = q.gte('fecha', inicioDia(req.query.desde));
  if (esFecha(req.query.hasta)) q = q.lt('fecha', finDia(req.query.hasta));
  const { data, error } = await q;
  if (error) throw error;
  res.json({ cierres: data });
}));

app.get('/api/admin/cierres/:id/registros', auth('admin'), wrap(async (req, res) => {
  const registros = await traerTodo(() => db.from('registros').select('id,placa,tipo,entrada,salida,minutos,valor')
    .eq('cierre_id', Number(req.params.id)).order('id'));
  res.json({ registros });
}));

app.put('/api/admin/cierres/:id', auth('admin'), wrap(async (req, res) => {
  const revisado = req.body.revisado === true;
  const { data, error } = await db.from('cierres_caja').update({
    revisado,
    revisado_en: revisado ? new Date().toISOString() : null,
    nota_admin: String(req.body.nota_admin || '').slice(0, 300),
  }).eq('id', Number(req.params.id)).select().single();
  if (error) throw error;
  res.json({ cierre: data });
}));

// ---------- Administrador: reporte por días ----------
app.get('/api/admin/reporte', auth('admin'), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const desde = esFecha(req.query.desde) ? req.query.desde : hoy;
  const hasta = esFecha(req.query.hasta) ? req.query.hasta : hoy;

  const [registros, movimientos, resumen] = await Promise.all([
    traerTodo(() => db.from('registros').select('id,placa,tipo,valor,minutos,entrada,salida')
      .eq('estado', 'salio').gte('salida', inicioDia(desde)).lt('salida', finDia(hasta)).order('id')),
    traerTodo(() => db.from('movimientos_mensualidad').select('id,placa,tipo,movimiento,fecha')
      .gte('fecha', inicioDia(desde)).lt('fecha', finDia(hasta)).order('id')),
    // Días viejos cuyo detalle ya se limpió: sus totales están en resumen_diario
    traerTodo(() => db.from('resumen_diario').select('fecha,tipo,cantidad,total')
      .gte('fecha', desde).lte('fecha', hasta).order('fecha').order('tipo')),
  ]);

  const nuevo = (fecha) => ({ fecha, porTipo: {}, cantidad: 0, total: 0, mensPorTipo: {}, mensEntradas: 0, mensSalidas: 0, resumido: false });
  const dias = {};
  const totales = nuevo(null);

  for (const s of resumen) {
    const dia = (dias[s.fecha] ??= nuevo(s.fecha));
    dia.resumido = true;
    for (const t of [dia, totales]) {
      const d = (t.porTipo[s.tipo] ??= { n: 0, valor: 0 });
      d.n += s.cantidad; d.valor += s.total; t.cantidad += s.cantidad; t.total += s.total;
    }
  }

  for (const r of registros) {
    const v = r.valor || 0;
    for (const t of [(dias[fechaBogota(r.salida)] ??= nuevo(fechaBogota(r.salida))), totales]) {
      const d = (t.porTipo[r.tipo] ??= { n: 0, valor: 0 });
      d.n++; d.valor += v; t.cantidad++; t.total += v;
    }
  }
  for (const m of movimientos) {
    for (const t of [(dias[fechaBogota(m.fecha)] ??= nuevo(fechaBogota(m.fecha))), totales]) {
      if (m.movimiento === 'salida') { t.mensSalidas++; continue; }
      t.mensEntradas++;
      t.mensPorTipo[m.tipo] = (t.mensPorTipo[m.tipo] || 0) + 1;
    }
  }

  const lista = Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha));
  res.json({ desde, hasta, dias: lista, totales, registros });
}));

// ---------- Administrador: estado del sistema (espacio de la base de datos) ----------
const LIMITE_BD = 500 * 1024 * 1024; // plan gratis de Supabase: 500 MB

app.get('/api/admin/sistema', auth('admin'), wrap(async (req, res) => {
  const [tam, cuenta, viejo, resumen] = await Promise.all([
    db.rpc('tamano_bd'),
    db.from('registros').select('id', { count: 'exact', head: true }),
    db.from('registros').select('entrada').order('entrada').limit(1),
    db.from('resumen_diario').select('fecha').order('fecha').limit(1),
  ]);
  for (const r of [tam, cuenta, viejo, resumen]) if (r.error) throw r.error;
  res.json({
    bytes: Number(tam.data) || 0,
    limite: LIMITE_BD,
    registros: cuenta.count || 0,
    detalleDesde: viejo.data[0]?.entrada || null,
    resumenDesde: resumen.data[0]?.fecha || null,
  });
}));

// ---------- Errores ----------
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Esa placa ya existe (registro duplicado)' });
  console.error(err);
  res.status(500).json({ error: 'Error del servidor: ' + (err.message || 'desconocido') });
});

app.listen(PORT, () => console.log(`Parqueadero listo en http://localhost:${PORT}`));