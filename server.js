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
// "2026-01-31" + 1 mes = "2026-02-28" (si el mes siguiente es más corto, usa su último día)
function sumarMes(f) {
  const [y, m, d] = f.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, ultimo))).toISOString().slice(0, 10);
}

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

// Nombre del parqueadero para la pantalla de ingreso (no requiere sesión)
app.get('/api/marca', wrap(async (req, res) => {
  const { data } = await db.from('configuracion').select('nombre').eq('id', 1).maybeSingle();
  res.json({ nombre: data?.nombre || 'Parqueadero' });
}));

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
    if (mens.fecha_fin >= fechaBogota()) {
      const mov = await entradaDeHoy(mens.id);
      return res.json({ mensualidad: { ...mens, entroHoy: !!mov, horaEntrada: mov?.fecha || null } });
    }
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
    const extra = mens ? ' Es una mensualidad: no paga salida (solo se marca la entrada).' : '';
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

// ---------- Mensualidades ----------
// Solo se marcan ENTRADAS. "Entró" quiere decir "entró HOY": a medianoche (hora Colombia)
// todas vuelven a quedar sin entrar automáticamente, sin tareas programadas.
async function entradaDeHoy(mensualidadId) {
  const hoy = fechaBogota();
  const { data, error } = await db.from('movimientos_mensualidad').select('id,fecha')
    .eq('mensualidad_id', mensualidadId).eq('movimiento', 'entrada')
    .gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function datosMensualidad(b) {
  const placa = limpiarPlaca(b.placa);
  if (placa.length < 2) throw errorUsuario('Escriba una placa válida');
  const { data: tarifa } = await db.from('tarifas').select('tipo').eq('tipo', String(b.tipo)).maybeSingle();
  if (!tarifa) throw errorUsuario('Seleccione el tipo de vehículo');
  if (!esFecha(b.fecha_fin)) throw errorUsuario('Escriba la fecha de vencimiento');
  return {
    placa,
    tipo: tarifa.tipo,
    propietario: String(b.propietario || '').trim().slice(0, 80),
    telefono: String(b.telefono || '').trim().slice(0, 40),
    valor: entero(b.valor),
    fecha_inicio: esFecha(b.fecha_inicio) ? b.fecha_inicio : fechaBogota(),
    fecha_fin: b.fecha_fin,
    activo: b.activo !== false,
  };
}

// Guarda el dinero recibido por una mensualidad (nueva o renovación)
async function registrarPago({ m, valor, usuario, enCaja, desde, hasta, clase }) {
  const { data, error } = await db.from('pagos_mensualidad').insert({
    mensualidad_id: m.id, placa: m.placa, tipo: m.tipo, propietario: m.propietario || '',
    valor, desde, hasta, usuario, en_caja: enCaja, clase,
  }).select().single();
  if (error) throw error;
  return data;
}

// Crea la mensualidad y, si se indica, su primer pago. Si el pago falla, no deja la mensualidad a medias.
async function crearMensualidad(datos, pago) {
  const { data: existe } = await db.from('mensualidades').select('id').eq('placa', datos.placa).maybeSingle();
  if (existe) throw errorUsuario(`${datos.placa} ya tiene mensualidad. Use el botón Renovar.`, 409);
  const { data: m, error } = await db.from('mensualidades').insert(datos).select().single();
  if (error) throw error;
  if (!pago) return { mensualidad: m, pago: null };
  try {
    const p = await registrarPago({ m, ...pago, desde: m.fecha_inicio, hasta: m.fecha_fin, clase: 'nueva' });
    return { mensualidad: m, pago: p };
  } catch (e) {
    await db.from('mensualidades').delete().eq('id', m.id);
    throw e;
  }
}

app.get('/api/mensualidades', auth(), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const [{ data: lista, error: e1 }, { data: movimientos, error: e2 }, { data: pagosHoy, error: e3 }] = await Promise.all([
    db.from('mensualidades').select('*').order('placa'),
    db.from('movimientos_mensualidad').select('*').gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).order('fecha', { ascending: false }),
    db.from('pagos_mensualidad').select('*').gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).order('fecha', { ascending: false }),
  ]);
  if (e1 || e2 || e3) throw e1 || e2 || e3;
  const entradas = {};
  for (const mv of movimientos) if (mv.movimiento === 'entrada') entradas[mv.mensualidad_id] = mv.fecha;
  res.json({
    mensualidades: lista.map((m) => ({
      ...m, vencida: m.fecha_fin < hoy,
      entroHoy: !!entradas[m.id], horaEntrada: entradas[m.id] || null,
      dentro: !!entradas[m.id],
    })),
    movimientosHoy: movimientos.filter((mv) => mv.movimiento === 'entrada'),
    pagosHoy,
  });
}));

// La caja crea una mensualidad nueva: queda vigente 1 mes y el pago entra a la caja
app.post('/api/mensualidades', auth(), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const datos = await datosMensualidad({ ...req.body, fecha_inicio: hoy, fecha_fin: sumarMes(hoy), activo: true });
  if (datos.valor <= 0) throw errorUsuario('Escriba el valor recibido');
  const r = await crearMensualidad(datos, { valor: datos.valor, usuario: req.usuario.usuario, enCaja: true });
  res.json(r);
}));

// Renovar: suma 1 mes (desde el vencimiento, o desde hoy si ya estaba vencida) y registra el pago
app.post('/api/mensualidades/:id/pago', auth(), wrap(async (req, res) => {
  const { data: m } = await db.from('mensualidades').select('*').eq('id', Number(req.params.id)).maybeSingle();
  if (!m) return res.status(404).json({ error: 'Mensualidad no encontrada' });
  const valor = entero(req.body.valor);
  if (valor <= 0) throw errorUsuario('Escriba el valor recibido');

  const hoy = fechaBogota();
  const base = m.fecha_fin >= hoy ? m.fecha_fin : hoy;
  const nuevaFin = sumarMes(base);
  // Solo el administrador puede indicar que el dinero NO quedó en la caja
  const enCaja = req.usuario.rol === 'admin' ? req.body.en_caja !== false : true;

  // Se actualiza solo si nadie la renovó al mismo tiempo (evita cobrar dos veces por doble clic)
  const { data: act, error } = await db.from('mensualidades')
    .update({ fecha_fin: nuevaFin, activo: true }).eq('id', m.id).eq('fecha_fin', m.fecha_fin).select();
  if (error) throw error;
  if (!act.length) throw errorUsuario(`${m.placa} acaba de ser renovada. Actualice la lista.`, 409);

  try {
    const pago = await registrarPago({ m, valor, usuario: req.usuario.usuario, enCaja, desde: base, hasta: nuevaFin, clase: 'renovacion' });
    res.json({ mensualidad: act[0], pago });
  } catch (e) {
    await db.from('mensualidades').update({ fecha_fin: m.fecha_fin }).eq('id', m.id);
    throw e;
  }
}));

app.post('/api/mensualidades/:id/movimiento', auth(), wrap(async (req, res) => {
  if (req.body.movimiento !== 'entrada') return res.status(400).json({ error: 'Las mensualidades solo registran la entrada' });
  const { data: m } = await db.from('mensualidades').select('*').eq('id', Number(req.params.id)).maybeSingle();
  if (!m) return res.status(404).json({ error: 'Mensualidad no encontrada' });
  if (!m.activo) return res.status(409).json({ error: `La mensualidad de ${m.placa} está inactiva.` });
  if (m.fecha_fin < fechaBogota()) return res.status(409).json({ error: `La mensualidad de ${m.placa} venció el ${m.fecha_fin}. Renuévela o regístrela como visitante.` });

  const ya = await entradaDeHoy(m.id);
  if (ya) return res.status(409).json({ error: `${m.placa} ya registró su entrada hoy a las ${new Date(ya.fecha).toLocaleTimeString('es-CO', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' })}` });

  const { error } = await db.from('movimientos_mensualidad').insert({ mensualidad_id: m.id, placa: m.placa, tipo: m.tipo, movimiento: 'entrada' });
  if (error) {
    // La base de datos no deja dos entradas el mismo día (doble clic o dos cajas al tiempo)
    if (error.code === '23505') return res.status(409).json({ error: `${m.placa} ya registró su entrada hoy.` });
    throw error;
  }
  res.json({ ok: true });
}));

// ---------- Total del día (caja) ----------
// Suma lo cobrado hoy en salidas + los pagos de mensualidades recibidos hoy en la caja
app.get('/api/caja/hoy', auth(), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const [regs, pagos] = await Promise.all([
    traerTodo(() => db.from('registros').select('id,tipo,valor').eq('estado', 'salio')
      .gte('salida', inicioDia(hoy)).lt('salida', finDia(hoy)).order('id')),
    traerTodo(() => db.from('pagos_mensualidad').select('id,valor').eq('en_caja', true)
      .gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).order('id')),
  ]);
  const porTipo = {};
  for (const r of regs) {
    const d = (porTipo[r.tipo] ??= { n: 0, valor: 0 });
    d.n++; d.valor += r.valor || 0;
  }
  const parqueo = { n: regs.length, valor: regs.reduce((t, r) => t + (r.valor || 0), 0) };
  const mensualidades = { n: pagos.length, valor: pagos.reduce((t, p) => t + (p.valor || 0), 0) };
  res.json({ fecha: hoy, parqueo, porTipo, mensualidades, total: parqueo.valor + mensualidades.valor });
}));

// ---------- Cierre de caja ----------
// "Pendiente" = dinero ya recibido que todavía no se ha entregado en un cierre
const pendientesCierre = () => traerTodo(() => db.from('registros')
  .select('id,placa,tipo,valor,salida').eq('estado', 'salio').is('cierre_id', null).order('id'));
const pagosPendientes = () => traerTodo(() => db.from('pagos_mensualidad')
  .select('id,placa,valor,fecha').eq('en_caja', true).is('cierre_id', null).order('id'));

// Agrupa el dinero: cobros por tipo + pagos de mensualidades
function resumenCaja(regs, pagos) {
  const r = { detalle: {}, cantidad: 0, total_sistema: 0, mens_pagos: 0, mens_valor: 0, desde: null, hasta: null };
  const fechas = (f) => {
    if (!r.desde || new Date(f) < new Date(r.desde)) r.desde = f;
    if (!r.hasta || new Date(f) > new Date(r.hasta)) r.hasta = f;
  };
  for (const x of regs) {
    const v = x.valor || 0;
    const d = (r.detalle[x.tipo] ??= { n: 0, valor: 0 });
    d.n++; d.valor += v;
    r.cantidad++; r.total_sistema += v;
    fechas(x.salida);
  }
  for (const p of pagos) {
    r.mens_pagos++; r.mens_valor += p.valor || 0; r.total_sistema += p.valor || 0;
    fechas(p.fecha);
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
  const [regs, pagos, mens, { data: cierresHoy, error }] = await Promise.all([
    pendientesCierre(),
    pagosPendientes(),
    entradasMensualidadHoy(),
    db.from('cierres_caja').select('*').gte('fecha', inicioDia(hoy)).lt('fecha', finDia(hoy)).order('fecha', { ascending: false }),
  ]);
  if (error) throw error;
  res.json({ pendiente: { ...resumenCaja(regs, pagos), mens_entradas: mens }, cierresHoy });
}));

app.post('/api/caja/cierre', auth(), wrap(async (req, res) => {
  const [regs, pagos] = await Promise.all([pendientesCierre(), pagosPendientes()]);
  if (!regs.length && !pagos.length) return res.status(400).json({ error: 'No hay dinero pendiente por cerrar' });

  const r = resumenCaja(regs, pagos);
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

  // Amarra exactamente el dinero contado a este cierre (de a 200 para no hacer URLs largas)
  for (const [tabla, filas] of [['registros', regs], ['pagos_mensualidad', pagos]]) {
    const ids = filas.map((x) => x.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error: e } = await db.from(tabla).update({ cierre_id: cierre.id }).in('id', ids.slice(i, i + 200));
      if (e) throw e;
    }
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
    valor_mes: entero(t.valor_mes),
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
// pago: 'caja' (el dinero quedó en la caja), 'admin' (lo recibió el administrador) o 'no' (sin pago)
app.post('/api/admin/mensualidades', auth('admin'), wrap(async (req, res) => {
  const datos = await datosMensualidad(req.body);
  const forma = ['caja', 'admin', 'no'].includes(req.body.pago) ? req.body.pago : 'caja';
  const pago = forma !== 'no' && datos.valor > 0 ? { valor: datos.valor, usuario: req.usuario.usuario, enCaja: forma === 'caja' } : null;
  res.json(await crearMensualidad(datos, pago));
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
  const id = Number(req.params.id);
  const [registros, pagos] = await Promise.all([
    traerTodo(() => db.from('registros').select('id,placa,tipo,entrada,salida,minutos,valor').eq('cierre_id', id).order('id')),
    traerTodo(() => db.from('pagos_mensualidad').select('id,placa,tipo,propietario,valor,fecha,hasta').eq('cierre_id', id).order('id')),
  ]);
  res.json({ registros, pagos });
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

  const [registros, movimientos, resumen, pagos] = await Promise.all([
    traerTodo(() => db.from('registros').select('id,placa,tipo,valor,minutos,entrada,salida')
      .eq('estado', 'salio').gte('salida', inicioDia(desde)).lt('salida', finDia(hasta)).order('id')),
    traerTodo(() => db.from('movimientos_mensualidad').select('id,placa,tipo,movimiento,fecha')
      .gte('fecha', inicioDia(desde)).lt('fecha', finDia(hasta)).order('id')),
    // Días viejos cuyo detalle ya se limpió: sus totales están en resumen_diario
    traerTodo(() => db.from('resumen_diario').select('fecha,tipo,cantidad,total')
      .gte('fecha', desde).lte('fecha', hasta).order('fecha').order('tipo')),
    traerTodo(() => db.from('pagos_mensualidad').select('id,placa,tipo,propietario,valor,fecha,hasta,en_caja,clase,usuario')
      .gte('fecha', inicioDia(desde)).lt('fecha', finDia(hasta)).order('id')),
  ]);

  const nuevo = (fecha) => ({ fecha, porTipo: {}, cantidad: 0, total: 0, mensPorTipo: {}, mensEntradas: 0, mensSalidas: 0, mensPagos: 0, mensValor: 0, resumido: false });
  const dias = {};
  const totales = nuevo(null);
  const dia = (f) => (dias[f] ??= nuevo(f));

  for (const s of resumen) {
    const d0 = dia(s.fecha);
    d0.resumido = true;
    for (const t of [d0, totales]) {
      const d = (t.porTipo[s.tipo] ??= { n: 0, valor: 0 });
      d.n += s.cantidad; d.valor += s.total; t.cantidad += s.cantidad; t.total += s.total;
    }
  }
  for (const r of registros) {
    const v = r.valor || 0;
    for (const t of [dia(fechaBogota(r.salida)), totales]) {
      const d = (t.porTipo[r.tipo] ??= { n: 0, valor: 0 });
      d.n++; d.valor += v; t.cantidad++; t.total += v;
    }
  }
  for (const m of movimientos) {
    for (const t of [dia(fechaBogota(m.fecha)), totales]) {
      if (m.movimiento === 'salida') { t.mensSalidas++; continue; }
      t.mensEntradas++;
      t.mensPorTipo[m.tipo] = (t.mensPorTipo[m.tipo] || 0) + 1;
    }
  }
  for (const p of pagos) {
    const v = p.valor || 0;
    for (const t of [dia(fechaBogota(p.fecha)), totales]) { t.mensPagos++; t.mensValor += v; t.total += v; }
  }

  const lista = Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha));
  res.json({ desde, hasta, dias: lista, totales, registros, pagos });
}));

// ---------- Administrador: relación de gastos (ingresos - egresos = ganancia) ----------
const esMes = (m) => /^\d{4}-\d{2}$/.test(m || '');
const ultimoDiaMes = (mes) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const mesAnterior = (mes) => { const [y, m] = mes.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };

function datosGasto(b) {
  const concepto = String(b.concepto || '').trim().slice(0, 80);
  if (!concepto) throw errorUsuario('Escriba el concepto del gasto (ej: Arriendo)');
  const valor = entero(b.valor);
  if (valor <= 0) throw errorUsuario('Escriba el valor del gasto');
  return { concepto, valor, fecha: esFecha(b.fecha) ? b.fecha : fechaBogota() };
}

app.get('/api/admin/gastos', auth('admin'), wrap(async (req, res) => {
  const mes = esMes(req.query.mes) ? req.query.mes : fechaBogota().slice(0, 7);
  const desde = `${mes}-01`, hasta = ultimoDiaMes(mes);

  const [gastos, registros, resumen, pagos, conceptos] = await Promise.all([
    traerTodo(() => db.from('gastos').select('*').gte('fecha', desde).lte('fecha', hasta).order('fecha').order('id')),
    traerTodo(() => db.from('registros').select('valor').eq('estado', 'salio')
      .gte('salida', inicioDia(desde)).lt('salida', finDia(hasta)).order('id')),
    traerTodo(() => db.from('resumen_diario').select('total').gte('fecha', desde).lte('fecha', hasta).order('fecha')),
    traerTodo(() => db.from('pagos_mensualidad').select('valor')
      .gte('fecha', inicioDia(desde)).lt('fecha', finDia(hasta)).order('id')),
    traerTodo(() => db.from('gastos').select('concepto').order('id', { ascending: false })),
  ]);

  const suma = (filas, campo = 'valor') => filas.reduce((t, x) => t + (x[campo] || 0), 0);
  const ingresos = {
    parqueo: suma(registros) + suma(resumen, 'total'),
    mensualidades: suma(pagos),
  };
  ingresos.total = ingresos.parqueo + ingresos.mensualidades;
  const egresos = suma(gastos);
  res.json({
    mes, desde, hasta, gastos, ingresos, egresos,
    ganancia: ingresos.total - egresos,
    conceptos: [...new Set(conceptos.map((c) => c.concepto))].slice(0, 30), // para sugerir al escribir
  });
}));

app.post('/api/admin/gastos', auth('admin'), wrap(async (req, res) => {
  const { data, error } = await db.from('gastos').insert(datosGasto(req.body)).select().single();
  if (error) throw error;
  res.json({ gasto: data });
}));

app.put('/api/admin/gastos/:id', auth('admin'), wrap(async (req, res) => {
  const { data, error } = await db.from('gastos').update(datosGasto(req.body)).eq('id', Number(req.params.id)).select().single();
  if (error) throw error;
  res.json({ gasto: data });
}));

app.delete('/api/admin/gastos/:id', auth('admin'), wrap(async (req, res) => {
  const { error } = await db.from('gastos').delete().eq('id', Number(req.params.id));
  if (error) throw error;
  res.json({ ok: true });
}));

// Copia los gastos del mes anterior al mes indicado (útil para gastos fijos: arriendo, empleado...)
app.post('/api/admin/gastos/copiar', auth('admin'), wrap(async (req, res) => {
  const mes = esMes(req.body.mes) ? req.body.mes : fechaBogota().slice(0, 7);
  const ant = mesAnterior(mes);
  const previos = await traerTodo(() => db.from('gastos').select('concepto,valor')
    .gte('fecha', `${ant}-01`).lte('fecha', ultimoDiaMes(ant)).order('id'));
  if (!previos.length) throw errorUsuario(`El mes anterior (${ant}) no tiene gastos para copiar`);
  const { error } = await db.from('gastos').insert(previos.map((g) => ({ ...g, fecha: `${mes}-01` })));
  if (error) throw error;
  res.json({ copiados: previos.length });
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