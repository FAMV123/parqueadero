# Parqueadero — Guía paso a paso (VS Code → GitHub → Supabase → Render → UptimeRobot)

Software web con dos usuarios:

- **Caja (operador):** escribe la placa → imprime recibo de entrada. A la salida escribe la placa → el sistema calcula tiempo y valor solo → cobra (e imprime recibo de pago si quiere). Pestaña **Mensualidades**: lista de placas fijas con botones **Entró / Salió**, sin recibo.
- **Administrador (dueño):** cambia tarifas, ve lo recaudado por día / semana / mes (motos, carros, mensualidades), crea y renueva mensualidades y edita los datos del recibo.

**Tecnología (todo gratis):** Node.js + Express (servidor), HTML/JS simple (pantallas), Supabase (base de datos Postgres), Render (hosting), UptimeRobot (mantenerlo despierto).

Estructura final de la carpeta:

```
parqueadero/
├── public/
│   ├── index.html      ← login
│   ├── caja.html       ← panel del operador
│   ├── admin.html      ← panel del dueño
│   ├── app.js          ← funciones compartidas + impresión de recibos
│   └── styles.css
├── sql/
│   └── schema.sql      ← tablas de la base de datos
├── server.js           ← servidor / API
├── tarifa.js           ← cálculo del cobro
├── package.json
├── .env.example
└── .gitignore
```

> **Atajo:** si descargas el `.zip` que te envié, descomprímelo dentro de tu carpeta `parqueadero` y salta al **Paso 3**. Si prefieres copiar y pegar, sigue todo en orden.

---

## Paso 0 — Requisitos en tu PC

1. **Node.js 20 o superior** (LTS): https://nodejs.org → instala y verifica en la terminal de VS Code (`Ctrl + ñ` o *Terminal → New Terminal*):

```bash
node -v
npm -v
```

2. **Git**: https://git-scm.com → verifica con `git -v`.
3. Cuentas: **GitHub**, **Supabase** (https://supabase.com), **Render** (https://render.com) y **UptimeRobot** (https://uptimerobot.com). Te recomiendo crear Supabase, Render y UptimeRobot con el **correo del parqueadero** que te dieron, así la cuenta queda a nombre del cliente y tú solo la administras.

---

## Paso 1 — Crear el proyecto en VS Code

Abre la carpeta `parqueadero` en VS Code (*File → Open Folder*) y en la terminal ejecuta:

```bash
npm init -y
npm install express @supabase/supabase-js jsonwebtoken dotenv
```

Crea las subcarpetas:

```bash
mkdir public sql
```

(En Windows PowerShell funciona igual. Si da error, créalas con clic derecho → *New Folder*.)

---

## Paso 2 — Copiar y pegar los archivos

Crea cada archivo (clic derecho → *New File*) con **el nombre exacto** y pega el código completo.

### 2.1 `package.json` (reemplaza el que creó `npm init`)

```json
{
  "name": "parqueadero",
  "version": "1.0.0",
  "description": "Software de gestión de parqueadero: caja (entradas/salidas con recibo), mensualidades y panel de administrador",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "jsonwebtoken": "^9.0.2"
  }
}
```

### 2.2 `.gitignore` (¡importante! evita subir tus claves a GitHub)

```text
node_modules/
.env
.DS_Store
```

### 2.3 `.env.example`

```bash
# Copie este archivo como .env y llene los valores (el .env NUNCA se sube a GitHub)

# Supabase > Project Settings > API
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=pegue_aqui_la_llave_service_role_o_secret

# Cualquier texto largo y aleatorio (firma las sesiones)
JWT_SECRET=cambie-esto-por-un-texto-largo-y-aleatorio

# Usuario del dueño (panel de administrador)
ADMIN_USER=admin
ADMIN_PASS=cambie-esta-clave

# Usuario de la persona de caja
OPERADOR_USER=caja
OPERADOR_PASS=cambie-esta-clave

PORT=3000
```

### 2.4 `tarifa.js` — cálculo del cobro

```js
// Cálculo del valor a cobrar. Se deja aparte para poder probarlo fácil.
//
// Reglas:
//  - Se cobra por hora o fracción, mínimo 1 hora.
//  - "minutos_gracia" es la tolerancia: si se pasa de la hora solo esos minutos, no se cobra otra hora.
//  - "tope_dia" (si es mayor que 0) es lo máximo que se cobra por cada bloque de 24 horas.
function calcularValor(minutos, tarifa) {
  const valorHora = Number(tarifa.valor_hora) || 0;
  const gracia = Number(tarifa.minutos_gracia) || 0;
  const tope = Number(tarifa.tope_dia) || 0;

  const porHoras = (m) => Math.max(1, Math.ceil((m - gracia) / 60)) * valorHora;

  if (!tope) return porHoras(minutos);

  const dias = Math.floor(minutos / 1440);
  const resto = minutos % 1440;
  let valor = dias * tope;
  if (dias === 0 || resto > gracia) valor += Math.min(tope, porHoras(resto));
  return valor;
}

module.exports = { calcularValor };
```

Ejemplos con moto a $1.000/hora, 5 min de gracia y tope de $8.000/día:

| Tiempo | Cobro |
|---|---|
| 3 min | $1.000 (mínimo 1 hora) |
| 1 h 04 min | $1.000 (está dentro de la gracia) |
| 1 h 06 min | $2.000 |
| 10 h | $8.000 (tope del día) |
| 25 h | $9.000 (1 día + 1 hora) |

### 2.5 `server.js` — servidor y API

```js
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

const limpiarPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function detectarTipo(placa) {
  if (/^[A-Z]{3}\d{3}$/.test(placa)) return 'carro';      // ABC123
  if (/^[A-Z]{3}\d{2}[A-Z]?$/.test(placa)) return 'moto'; // ABC12D o ABC12
  return null;
}
const entero = (v) => Math.max(0, Math.round(Number(v) || 0));

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
  const { data, error } = await db.from('tarifas').select('*').eq('tipo', tipo).single();
  if (error) throw error;
  return data;
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
    db.from('tarifas').select('*').order('tipo'),
  ]);
  if (e1 || e2) throw e1 || e2;
  res.json({ config, tarifas });
}));

app.post('/api/entrada', auth(), wrap(async (req, res) => {
  const placa = limpiarPlaca(req.body.placa);
  if (placa.length < 5) return res.status(400).json({ error: 'Escriba una placa válida' });

  // ¿Es mensualidad vigente? Entonces no se imprime recibo
  const { data: mens } = await db.from('mensualidades').select('*').eq('placa', placa).maybeSingle();
  let aviso = '';
  if (mens && mens.activo) {
    if (mens.fecha_fin >= fechaBogota()) return res.json({ mensualidad: mens });
    aviso = `La mensualidad de ${placa} está vencida desde ${mens.fecha_fin}. Se registra como visitante.`;
  }

  const tipo = ['moto', 'carro'].includes(req.body.tipo) ? req.body.tipo : detectarTipo(placa);
  if (!tipo) return res.status(400).json({ error: 'Seleccione si es MOTO o CARRO' });

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

app.get('/api/registro/:id', auth(), wrap(async (req, res) => {
  const { data, error } = await db.from('registros').select('*').eq('id', Number(req.params.id)).single();
  if (error) return res.status(404).json({ error: 'No existe ese recibo' });
  res.json({ registro: data });
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

  const { error: e1 } = await db.from('movimientos_mensualidad').insert({ mensualidad_id: m.id, placa: m.placa, tipo: m.tipo, movimiento });
  if (e1) throw e1;
  const { error: e2 } = await db.from('mensualidades').update({ dentro: movimiento === 'entrada' }).eq('id', m.id);
  if (e2) throw e2;
  res.json({ ok: true });
}));

// ---------- Administrador ----------
app.put('/api/admin/tarifas', auth('admin'), wrap(async (req, res) => {
  const tarifas = Array.isArray(req.body.tarifas) ? req.body.tarifas : [];
  for (const t of tarifas) {
    if (!['moto', 'carro'].includes(t.tipo)) continue;
    const { error } = await db.from('tarifas').update({
      valor_hora: entero(t.valor_hora),
      minutos_gracia: entero(t.minutos_gracia),
      tope_dia: entero(t.tope_dia),
      actualizado: new Date().toISOString(),
    }).eq('tipo', t.tipo);
    if (error) throw error;
  }
  res.json({ ok: true });
}));

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

function datosMensualidad(b) {
  const placa = limpiarPlaca(b.placa);
  if (placa.length < 5) throw Object.assign(new Error('Escriba una placa válida'), { status: 400 });
  if (!['moto', 'carro'].includes(b.tipo)) throw Object.assign(new Error('Seleccione moto o carro'), { status: 400 });
  if (!esFecha(b.fecha_fin)) throw Object.assign(new Error('Escriba la fecha de vencimiento'), { status: 400 });
  return {
    placa,
    tipo: b.tipo,
    propietario: String(b.propietario || '').slice(0, 80),
    telefono: String(b.telefono || '').slice(0, 40),
    valor: entero(b.valor),
    fecha_inicio: esFecha(b.fecha_inicio) ? b.fecha_inicio : fechaBogota(),
    fecha_fin: b.fecha_fin,
    activo: b.activo !== false,
  };
}

app.post('/api/admin/mensualidades', auth('admin'), wrap(async (req, res) => {
  const { data, error } = await db.from('mensualidades').insert(datosMensualidad(req.body)).select().single();
  if (error) throw error;
  res.json({ mensualidad: data });
}));

app.put('/api/admin/mensualidades/:id', auth('admin'), wrap(async (req, res) => {
  const { data, error } = await db.from('mensualidades').update(datosMensualidad(req.body)).eq('id', Number(req.params.id)).select().single();
  if (error) throw error;
  res.json({ mensualidad: data });
}));

app.delete('/api/admin/mensualidades/:id', auth('admin'), wrap(async (req, res) => {
  const { error } = await db.from('mensualidades').delete().eq('id', Number(req.params.id));
  if (error) throw error;
  res.json({ ok: true });
}));

// Reporte por días: cantidad e ingresos de motos/carros + movimientos de mensualidades
app.get('/api/admin/reporte', auth('admin'), wrap(async (req, res) => {
  const hoy = fechaBogota();
  const desde = esFecha(req.query.desde) ? req.query.desde : hoy;
  const hasta = esFecha(req.query.hasta) ? req.query.hasta : hoy;

  const [registros, movimientos] = await Promise.all([
    traerTodo(() => db.from('registros').select('id,placa,tipo,valor,minutos,entrada,salida')
      .eq('estado', 'salio').gte('salida', inicioDia(desde)).lt('salida', finDia(hasta)).order('id')),
    traerTodo(() => db.from('movimientos_mensualidad').select('id,placa,tipo,movimiento,fecha')
      .gte('fecha', inicioDia(desde)).lt('fecha', finDia(hasta)).order('id')),
  ]);

  const dias = {};
  const dia = (f) => (dias[f] ??= { fecha: f, motos: 0, carros: 0, ingresoMotos: 0, ingresoCarros: 0, total: 0, mensMotos: 0, mensCarros: 0, mensSalidas: 0 });

  for (const r of registros) {
    const d = dia(fechaBogota(r.salida));
    const v = r.valor || 0;
    if (r.tipo === 'moto') { d.motos++; d.ingresoMotos += v; } else { d.carros++; d.ingresoCarros += v; }
    d.total += v;
  }
  for (const m of movimientos) {
    const d = dia(fechaBogota(m.fecha));
    if (m.movimiento === 'salida') d.mensSalidas++;
    else if (m.tipo === 'moto') d.mensMotos++;
    else d.mensCarros++;
  }

  const lista = Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const totales = { motos: 0, carros: 0, ingresoMotos: 0, ingresoCarros: 0, total: 0, mensMotos: 0, mensCarros: 0, mensSalidas: 0 };
  for (const d of lista) for (const k of Object.keys(totales)) totales[k] += d[k];

  res.json({ desde, hasta, dias: lista, totales, registros, movimientos });
}));

// ---------- Errores ----------
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Esa placa ya existe (registro duplicado)' });
  console.error(err);
  res.status(500).json({ error: 'Error del servidor: ' + (err.message || 'desconocido') });
});

app.listen(PORT, () => console.log(`Parqueadero listo en http://localhost:${PORT}`));
```

### 2.6 `sql/schema.sql` — base de datos

```sql
-- =========================================================
--  PARQUEADERO - Esquema de base de datos (Supabase / Postgres)
--  Pegar completo en Supabase > SQL Editor > New query > Run
-- =========================================================

-- 1) Tarifas por tipo de vehículo (las cambia el administrador)
create table if not exists tarifas (
  tipo            text primary key check (tipo in ('moto','carro')),
  valor_hora      integer not null default 0,   -- valor por hora o fracción
  minutos_gracia  integer not null default 5,   -- tolerancia antes de cobrar la siguiente hora
  tope_dia        integer not null default 0,   -- máximo a cobrar por cada 24 h (0 = sin tope)
  actualizado     timestamptz not null default now()
);

insert into tarifas (tipo, valor_hora, minutos_gracia, tope_dia) values
  ('moto', 1000, 5, 8000),
  ('carro', 3000, 5, 25000)
on conflict (tipo) do nothing;

-- 2) Datos que salen en el recibo impreso
create table if not exists configuracion (
  id           integer primary key default 1 check (id = 1),
  nombre       text not null default 'PARQUEADERO',
  nit          text not null default '',
  direccion    text not null default '',
  telefono     text not null default '',
  mensaje      text not null default 'Gracias por su visita. No nos hacemos responsables por objetos dejados en el vehículo.',
  ancho_papel  text not null default '58' check (ancho_papel in ('58','80'))
);

insert into configuracion (id) values (1) on conflict (id) do nothing;

-- 3) Registros diarios (entrada / salida con cobro)
create table if not exists registros (
  id        bigint generated always as identity primary key,
  placa     text not null,
  tipo      text not null check (tipo in ('moto','carro')),
  entrada   timestamptz not null default now(),
  salida    timestamptz,
  minutos   integer,
  valor     integer,
  estado    text not null default 'dentro' check (estado in ('dentro','salio'))
);

-- Una misma placa no puede estar "dentro" dos veces
create unique index if not exists registros_placa_dentro on registros (placa) where estado = 'dentro';
create index if not exists registros_salida_idx on registros (salida);

-- 4) Mensualidades (placas fijas)
create table if not exists mensualidades (
  id            bigint generated always as identity primary key,
  placa         text not null unique,
  tipo          text not null check (tipo in ('moto','carro')),
  propietario   text not null default '',
  telefono      text not null default '',
  valor         integer not null default 0,
  fecha_inicio  date not null default current_date,
  fecha_fin     date not null,
  activo        boolean not null default true,
  dentro        boolean not null default false,
  creado        timestamptz not null default now()
);

-- 5) Entradas / salidas de las mensualidades (sin recibo)
create table if not exists movimientos_mensualidad (
  id              bigint generated always as identity primary key,
  mensualidad_id  bigint references mensualidades(id) on delete cascade,
  placa           text not null,
  tipo            text not null,
  movimiento      text not null check (movimiento in ('entrada','salida')),
  fecha           timestamptz not null default now()
);

create index if not exists movimientos_fecha_idx on movimientos_mensualidad (fecha);

-- 6) Seguridad: se activa RLS sin políticas.
--    Así NADIE puede leer las tablas con la llave pública (anon).
--    Solo nuestro servidor, que usa la llave secreta (service_role), tiene acceso.
alter table tarifas                 enable row level security;
alter table configuracion           enable row level security;
alter table registros               enable row level security;
alter table mensualidades           enable row level security;
alter table movimientos_mensualidad enable row level security;
```

### 2.7 `public/styles.css`

```css
:root {
  --fondo: #f3f4f6;
  --tarjeta: #ffffff;
  --texto: #111827;
  --suave: #6b7280;
  --borde: #e5e7eb;
  --primario: #1d4ed8;
  --verde: #15803d;
  --rojo: #b91c1c;
  --amarillo: #b45309;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--fondo); color: var(--texto); }
header { background: #111827; color: #fff; padding: 12px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
header h1 { font-size: 18px; margin: 0; flex: 1; }
header a, header button { color: #fff; background: transparent; border: 1px solid #4b5563; border-radius: 8px; padding: 6px 12px; text-decoration: none; cursor: pointer; font-size: 14px; }
main { max-width: 1150px; margin: 0 auto; padding: 16px; }
.tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.tabs button { border: 0; background: #e5e7eb; padding: 10px 16px; border-radius: 10px; font-size: 15px; cursor: pointer; }
.tabs button.activa { background: var(--primario); color: #fff; }
.vista { display: none; }
.vista.activa { display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.card { background: var(--tarjeta); border: 1px solid var(--borde); border-radius: 14px; padding: 18px; margin-bottom: 14px; }
.card h2 { margin: 0 0 12px; font-size: 18px; }
label { display: block; font-size: 13px; color: var(--suave); margin: 8px 0 4px; }
input, select, textarea { width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 15px; font-family: inherit; }
input.placa { font-size: 30px; text-transform: uppercase; letter-spacing: 4px; text-align: center; font-weight: 700; }
button.btn { border: 0; border-radius: 10px; padding: 12px 16px; font-size: 16px; font-weight: 600; cursor: pointer; background: var(--primario); color: #fff; }
button.btn.ancho { width: 100%; margin-top: 12px; }
button.btn.verde { background: var(--verde); }
button.btn.rojo { background: var(--rojo); }
button.btn.gris { background: #e5e7eb; color: var(--texto); }
button.btn.chico { padding: 6px 10px; font-size: 13px; }
button:disabled { opacity: .5; cursor: wait; }
.selector { display: flex; gap: 8px; margin-top: 10px; }
.selector button { flex: 1; padding: 12px; font-size: 16px; border-radius: 10px; border: 2px solid #d1d5db; background: #fff; cursor: pointer; font-weight: 600; }
.selector button.activo { border-color: var(--primario); background: #dbeafe; }
.aviso { margin-top: 10px; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
.aviso:empty { display: none; }
.aviso.ok { background: #dcfce7; color: #14532d; }
.aviso.error { background: #fee2e2; color: #7f1d1d; }
.aviso.info { background: #fef3c7; color: #78350f; }
.resultado { margin-top: 12px; }
.resultado .total { font-size: 34px; font-weight: 800; color: var(--verde); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--borde); }
th { color: var(--suave); font-weight: 600; font-size: 12px; text-transform: uppercase; }
.tabla { overflow-x: auto; }
.chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.chip.dentro { background: #dcfce7; color: #14532d; }
.chip.fuera { background: #e5e7eb; color: #374151; }
.chip.vencida { background: #fee2e2; color: #7f1d1d; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.kpi { background: var(--tarjeta); border: 1px solid var(--borde); border-radius: 12px; padding: 14px; }
.kpi .t { font-size: 12px; color: var(--suave); text-transform: uppercase; }
.kpi .v { font-size: 24px; font-weight: 800; margin-top: 4px; }
.kpi .s { font-size: 13px; color: var(--suave); }
.fila { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
.fila > * { flex: 1; min-width: 130px; }
.acciones { display: flex; gap: 6px; flex-wrap: wrap; }
.login { max-width: 380px; margin: 10vh auto; }
.nota { font-size: 13px; color: var(--suave); }
```

### 2.8 `public/app.js` — funciones compartidas e impresión

```js
// Funciones compartidas por todas las páginas

async function api(url, opciones = {}) {
  const res = await fetch(url, {
    method: opciones.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { salir(); throw new Error(data.error || 'Sesión vencida'); }
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error');
  return data;
}

function salir() {
  localStorage.removeItem('token');
  localStorage.removeItem('rol');
  location.href = '/';
}

function exigirSesion(rol) {
  if (!localStorage.getItem('token')) { location.href = '/'; return; }
  if (rol === 'admin' && localStorage.getItem('rol') !== 'admin') location.href = '/caja.html';
}

const ZONA = 'America/Bogota';
const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
const fechaHora = (d) => new Date(d).toLocaleString('es-CO', { timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const hora = (d) => new Date(d).toLocaleTimeString('es-CO', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: true });
const hoyStr = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
function sumarDias(f, n) { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function duracion(min) {
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d ? d + ' d' : '', h ? h + ' h' : '', m + ' min'].filter(Boolean).join(' ');
}
const minutosDesde = (d) => Math.max(0, Math.floor((Date.now() - new Date(d)) / 60000));
const limpiarPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function detectarTipo(placa) {
  if (/^[A-Z]{3}\d{3}$/.test(placa)) return 'carro';
  if (/^[A-Z]{3}\d{2}[A-Z]?$/.test(placa)) return 'moto';
  return null;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function aviso(el, texto, tipo = 'ok') { el.className = 'aviso ' + tipo; el.textContent = texto; }

// Pestañas: <div class="tabs"><button data-vista="x"> ... <section class="vista" id="x">
function activarPestanas(alCambiar) {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('activa', x === b));
    document.querySelectorAll('.vista').forEach((v) => v.classList.toggle('activa', v.id === b.dataset.vista));
    if (alCambiar) alCambiar(b.dataset.vista);
  }));
}

// ---------- Impresión de recibos (impresora térmica 58 u 80 mm) ----------
function imprimir(contenidoHtml, anchoPapel) {
  const mm = anchoPapel === '80' ? 80 : 58;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${mm}mm auto; margin: 0; }
    body { width: ${mm - 8}mm; margin: 0 auto; padding: 2mm 0 6mm; font-family: 'Courier New', monospace; font-size: 12px; color: #000; }
    .c { text-align: center; } .g { font-size: 26px; font-weight: bold; letter-spacing: 2px; }
    .t { font-size: 20px; font-weight: bold; } p { margin: 2px 0; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  </style></head><body>${contenidoHtml}</body></html>`);
  doc.close();
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 60000);
  }, 250);
}

function encabezadoRecibo(cfg) {
  return `<div class="c"><p><b>${esc(cfg.nombre)}</b></p>
    ${cfg.nit ? `<p>NIT ${esc(cfg.nit)}</p>` : ''}
    ${cfg.direccion ? `<p>${esc(cfg.direccion)}</p>` : ''}
    ${cfg.telefono ? `<p>Tel. ${esc(cfg.telefono)}</p>` : ''}</div><hr>`;
}

function reciboEntrada(cfg, r) {
  return `${encabezadoRecibo(cfg)}
    <p class="c">RECIBO DE ENTRADA N° ${r.id}</p>
    <p class="c g">${esc(r.placa)}</p>
    <p class="c">${r.tipo.toUpperCase()}</p><hr>
    <p>Entrada: ${fechaHora(r.entrada)}</p><hr>
    <p class="c">${esc(cfg.mensaje)}</p>`;
}

function reciboSalida(cfg, r) {
  return `${encabezadoRecibo(cfg)}
    <p class="c">RECIBO DE PAGO N° ${r.id}</p>
    <p class="c g">${esc(r.placa)}</p>
    <p class="c">${r.tipo.toUpperCase()}</p><hr>
    <p>Entrada: ${fechaHora(r.entrada)}</p>
    <p>Salida:  ${fechaHora(r.salida)}</p>
    <p>Tiempo:  ${duracion(r.minutos)}</p><hr>
    <p class="c t">TOTAL ${pesos(r.valor)}</p><hr>
    <p class="c">${esc(cfg.mensaje)}</p>`;
}
```

### 2.9 `public/index.html` — login

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Parqueadero - Ingreso</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main>
    <div class="card login">
      <h2>🅿️ Parqueadero</h2>
      <form id="form">
        <label>Usuario</label>
        <input id="usuario" autocomplete="username" required autofocus>
        <label>Clave</label>
        <input id="clave" type="password" autocomplete="current-password" required>
        <button class="btn ancho" type="submit">Ingresar</button>
        <div id="msg" class="aviso"></div>
      </form>
    </div>
  </main>
  <script src="/app.js"></script>
  <script>
    const destino = (rol) => (rol === 'admin' ? '/admin.html' : '/caja.html');
    if (localStorage.getItem('token')) location.href = destino(localStorage.getItem('rol'));

    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('msg');
      try {
        const r = await api('/api/login', { method: 'POST', body: {
          usuario: document.getElementById('usuario').value.trim(),
          clave: document.getElementById('clave').value,
        } });
        localStorage.setItem('token', r.token);
        localStorage.setItem('rol', r.rol);
        location.href = destino(r.rol);
      } catch (err) { aviso(msg, err.message, 'error'); }
    });
  </script>
</body>
</html>
```

### 2.10 `public/caja.html` — panel de caja

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Parqueadero - Caja</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header>
    <h1>🅿️ Caja</h1>
    <a id="linkAdmin" href="/admin.html" style="display:none">Panel administrador</a>
    <button onclick="salir()">Salir</button>
  </header>

  <main>
    <div class="tabs">
      <button class="activa" data-vista="vCaja">Entrada / Salida</button>
      <button data-vista="vMens">Mensualidades</button>
    </div>

    <!-- ================= ENTRADA / SALIDA ================= -->
    <section id="vCaja" class="vista activa">
      <div class="grid">
        <div class="card">
          <h2>⬇️ Entrada</h2>
          <form id="formEntrada">
            <input id="placaEntrada" class="placa" placeholder="ABC123" maxlength="8" autocomplete="off" autofocus>
            <div class="selector" id="selTipo">
              <button type="button" data-tipo="moto">🏍️ Moto</button>
              <button type="button" data-tipo="carro">🚗 Carro</button>
            </div>
            <button class="btn ancho" type="submit">Registrar e imprimir recibo</button>
          </form>
          <div id="msgEntrada" class="aviso"></div>
          <div id="boxMens"></div>
        </div>

        <div class="card">
          <h2>⬆️ Salida</h2>
          <form id="formSalida">
            <input id="placaSalida" class="placa" placeholder="ABC123" maxlength="8" autocomplete="off">
            <button class="btn ancho gris" type="submit">Buscar placa</button>
          </form>
          <div id="msgSalida" class="aviso"></div>
          <div id="resSalida" class="resultado"></div>
        </div>
      </div>

      <div class="card">
        <h2>Vehículos dentro ahora: <span id="numDentro">0</span></h2>
        <div class="tabla">
          <table>
            <thead><tr><th>Recibo</th><th>Placa</th><th>Tipo</th><th>Entrada</th><th>Tiempo</th><th></th></tr></thead>
            <tbody id="tablaDentro"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ================= MENSUALIDADES ================= -->
    <section id="vMens" class="vista">
      <div class="kpis">
        <div class="kpi"><div class="t">Motos entraron hoy</div><div class="v" id="kMotos">0</div></div>
        <div class="kpi"><div class="t">Carros entraron hoy</div><div class="v" id="kCarros">0</div></div>
        <div class="kpi"><div class="t">Salidas hoy</div><div class="v" id="kSalidas">0</div></div>
        <div class="kpi"><div class="t">Dentro ahora</div><div class="v" id="kDentro">0</div></div>
      </div>
      <div class="card">
        <input id="buscarMens" placeholder="Buscar placa o propietario..." autocomplete="off">
        <div id="msgMens" class="aviso"></div>
        <div class="tabla">
          <table>
            <thead><tr><th>Placa</th><th>Tipo</th><th>Propietario</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
            <tbody id="tablaMens"></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>Movimientos de hoy</h2>
        <div class="tabla">
          <table>
            <thead><tr><th>Hora</th><th>Placa</th><th>Tipo</th><th>Movimiento</th></tr></thead>
            <tbody id="tablaMovs"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <script src="/app.js"></script>
  <script>
    exigirSesion();
    if (localStorage.getItem('rol') === 'admin') document.getElementById('linkAdmin').style.display = '';

    let config = { nombre: 'PARQUEADERO', ancho_papel: '58', mensaje: '' };
    let tipoElegido = null;
    let mensualidades = [];

    const $ = (id) => document.getElementById(id);

    async function cargarConfig() {
      try { config = (await api('/api/config')).config; } catch (e) { console.error(e); }
    }

    // ---------- Entrada ----------
    function marcarTipo(tipo) {
      tipoElegido = tipo;
      document.querySelectorAll('#selTipo button').forEach((b) => b.classList.toggle('activo', b.dataset.tipo === tipo));
    }
    document.querySelectorAll('#selTipo button').forEach((b) => b.addEventListener('click', () => marcarTipo(b.dataset.tipo)));
    $('placaEntrada').addEventListener('input', (e) => {
      const tipo = detectarTipo(limpiarPlaca(e.target.value));
      marcarTipo(tipo);
    });

    $('formEntrada').addEventListener('submit', async (e) => {
      e.preventDefault();
      const placa = limpiarPlaca($('placaEntrada').value);
      const btn = e.submitter; btn.disabled = true;
      $('boxMens').innerHTML = '';
      try {
        const r = await api('/api/entrada', { method: 'POST', body: { placa, tipo: tipoElegido } });
        if (r.mensualidad) {
          aviso($('msgEntrada'), `${placa} es MENSUALIDAD (${r.mensualidad.propietario || 'sin nombre'}). No se imprime recibo.`, 'info');
          $('boxMens').innerHTML = `<button class="btn ancho verde" id="btnMensEntro">Marcar entrada de mensualidad</button>`;
          $('btnMensEntro').onclick = async () => {
            await moverMensualidad(r.mensualidad.id, 'entrada');
            aviso($('msgEntrada'), `Entrada de mensualidad ${placa} registrada ✔`, 'ok');
            $('boxMens').innerHTML = '';
          };
        } else {
          imprimir(reciboEntrada(config, r.registro), config.ancho_papel);
          aviso($('msgEntrada'), `${r.registro.placa} registrada a las ${hora(r.registro.entrada)} ✔ ${r.aviso || ''}`, r.aviso ? 'info' : 'ok');
        }
        $('placaEntrada').value = ''; marcarTipo(null); $('placaEntrada').focus();
        cargarDentro();
      } catch (err) { aviso($('msgEntrada'), err.message, 'error'); }
      btn.disabled = false;
    });

    // ---------- Salida ----------
    async function consultarSalida(placa) {
      $('resSalida').innerHTML = '';
      try {
        const r = await api('/api/salida/consultar', { method: 'POST', body: { placa } });
        $('msgSalida').className = 'aviso'; $('msgSalida').textContent = '';
        $('resSalida').innerHTML = `
          <p><b style="font-size:22px">${esc(r.registro.placa)}</b> · ${r.registro.tipo.toUpperCase()}</p>
          <p>Entró: ${fechaHora(r.registro.entrada)}</p>
          <p>Tiempo: <b>${duracion(r.minutos)}</b></p>
          <div class="total">${pesos(r.valor)}</div>
          <label><input type="checkbox" id="chkImprimir" checked style="width:auto"> Imprimir recibo de pago</label>
          <button class="btn ancho verde" id="btnCobrar">Cobrar y dar salida</button>`;
        $('btnCobrar').onclick = () => confirmarSalida(r.registro.id);
      } catch (err) { aviso($('msgSalida'), err.message, 'error'); }
    }

    async function confirmarSalida(id) {
      $('btnCobrar').disabled = true;
      try {
        const { registro } = await api('/api/salida/confirmar', { method: 'POST', body: { id } });
        if ($('chkImprimir').checked) imprimir(reciboSalida(config, registro), config.ancho_papel);
        aviso($('msgSalida'), `${registro.placa} salió. Cobrado: ${pesos(registro.valor)} ✔`, 'ok');
        $('resSalida').innerHTML = ''; $('placaSalida').value = ''; $('placaSalida').focus();
        cargarDentro();
      } catch (err) { aviso($('msgSalida'), err.message, 'error'); $('btnCobrar').disabled = false; }
    }

    $('formSalida').addEventListener('submit', (e) => { e.preventDefault(); consultarSalida(limpiarPlaca($('placaSalida').value)); });

    // ---------- Vehículos dentro ----------
    let dentro = [];
    async function cargarDentro() {
      try {
        dentro = (await api('/api/dentro')).registros;
        $('numDentro').textContent = dentro.length;
        $('tablaDentro').innerHTML = dentro.map((r) => `<tr>
          <td>${r.id}</td><td><b>${esc(r.placa)}</b></td><td>${r.tipo}</td>
          <td>${fechaHora(r.entrada)}</td><td>${duracion(minutosDesde(r.entrada))}</td>
          <td class="acciones">
            <button class="btn chico" onclick="darSalida('${esc(r.placa)}')">Salida</button>
            <button class="btn chico gris" onclick="reimprimir(${r.id})">Reimprimir</button>
          </td></tr>`).join('') || '<tr><td colspan="6" class="nota">No hay vehículos dentro</td></tr>';
      } catch (e) { console.error(e); }
    }
    function darSalida(placa) { $('placaSalida').value = placa; consultarSalida(placa); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    function reimprimir(id) { const r = dentro.find((x) => x.id === id); if (r) imprimir(reciboEntrada(config, r), config.ancho_papel); }

    // ---------- Mensualidades ----------
    async function moverMensualidad(id, movimiento) {
      await api(`/api/mensualidades/${id}/movimiento`, { method: 'POST', body: { movimiento } });
      cargarMensualidades();
    }

    async function cargarMensualidades() {
      try {
        const r = await api('/api/mensualidades');
        mensualidades = r.mensualidades;
        const movs = r.movimientosHoy;
        $('kMotos').textContent = movs.filter((m) => m.movimiento === 'entrada' && m.tipo === 'moto').length;
        $('kCarros').textContent = movs.filter((m) => m.movimiento === 'entrada' && m.tipo === 'carro').length;
        $('kSalidas').textContent = movs.filter((m) => m.movimiento === 'salida').length;
        $('kDentro').textContent = mensualidades.filter((m) => m.dentro).length;
        $('tablaMovs').innerHTML = movs.map((m) => `<tr><td>${hora(m.fecha)}</td><td><b>${esc(m.placa)}</b></td><td>${m.tipo}</td><td>${m.movimiento === 'entrada' ? '⬇️ Entró' : '⬆️ Salió'}</td></tr>`).join('')
          || '<tr><td colspan="4" class="nota">Sin movimientos hoy</td></tr>';
        pintarMensualidades();
      } catch (e) { aviso($('msgMens'), e.message, 'error'); }
    }

    function pintarMensualidades() {
      const q = $('buscarMens').value.trim().toUpperCase();
      const lista = mensualidades.filter((m) => m.activo && (!q || m.placa.includes(limpiarPlaca(q)) || (m.propietario || '').toUpperCase().includes(q)));
      $('tablaMens').innerHTML = lista.map((m) => {
        const estado = m.vencida ? '<span class="chip vencida">Vencida</span>' : m.dentro ? '<span class="chip dentro">Dentro</span>' : '<span class="chip fuera">Fuera</span>';
        return `<tr><td><b>${esc(m.placa)}</b></td><td>${m.tipo}</td><td>${esc(m.propietario)}</td><td>${m.fecha_fin}</td><td>${estado}</td>
          <td class="acciones">
            <button class="btn chico verde" onclick="moverMensualidad(${m.id},'entrada')">Entró</button>
            <button class="btn chico rojo" onclick="moverMensualidad(${m.id},'salida')">Salió</button>
          </td></tr>`;
      }).join('') || '<tr><td colspan="6" class="nota">No hay mensualidades (el administrador las crea en su panel)</td></tr>';
    }
    $('buscarMens').addEventListener('input', pintarMensualidades);

    activarPestanas((v) => { if (v === 'vMens') cargarMensualidades(); });
    cargarConfig();
    cargarDentro();
    setInterval(cargarDentro, 60000);
  </script>
</body>
</html>
```

### 2.11 `public/admin.html` — panel del administrador

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Parqueadero - Administrador</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header>
    <h1>🅿️ Panel del administrador</h1>
    <a href="/caja.html">Ir a la caja</a>
    <button onclick="salir()">Salir</button>
  </header>

  <main>
    <div class="tabs">
      <button class="activa" data-vista="vResumen">Resumen</button>
      <button data-vista="vTarifas">Tarifas</button>
      <button data-vista="vMens">Mensualidades</button>
      <button data-vista="vRecibo">Datos del recibo</button>
    </div>

    <!-- ================= RESUMEN ================= -->
    <section id="vResumen" class="vista activa">
      <div class="card">
        <div class="fila">
          <button class="btn gris" onclick="rango('hoy')">Hoy</button>
          <button class="btn gris" onclick="rango('ayer')">Ayer</button>
          <button class="btn gris" onclick="rango('semana')">Esta semana</button>
          <button class="btn gris" onclick="rango('mes')">Este mes</button>
          <div><label>Desde</label><input type="date" id="desde"></div>
          <div><label>Hasta</label><input type="date" id="hasta"></div>
          <button class="btn" onclick="cargarReporte()">Consultar</button>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="t">Total recaudado</div><div class="v" id="kTotal">$0</div><div class="s" id="kRango"></div></div>
        <div class="kpi"><div class="t">Motos</div><div class="v" id="kMotos">0</div><div class="s" id="kMotosV"></div></div>
        <div class="kpi"><div class="t">Carros</div><div class="v" id="kCarros">0</div><div class="s" id="kCarrosV"></div></div>
        <div class="kpi"><div class="t">Mensualidades (entradas)</div><div class="v" id="kMens">0</div><div class="s" id="kMensD"></div></div>
        <div class="kpi"><div class="t">Dentro ahora</div><div class="v" id="kDentro">0</div><div class="s">visitantes</div></div>
      </div>
      <div class="card">
        <h2>Por día</h2>
        <div class="tabla">
          <table>
            <thead><tr><th>Fecha</th><th>Motos</th><th>$ Motos</th><th>Carros</th><th>$ Carros</th><th>Total</th><th>Mens. motos</th><th>Mens. carros</th><th>Mens. salidas</th></tr></thead>
            <tbody id="tablaDias"></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>Detalle de cobros</h2>
        <div class="tabla">
          <table>
            <thead><tr><th>Recibo</th><th>Placa</th><th>Tipo</th><th>Entrada</th><th>Salida</th><th>Tiempo</th><th>Valor</th></tr></thead>
            <tbody id="tablaDetalle"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ================= TARIFAS ================= -->
    <section id="vTarifas" class="vista">
      <div class="grid" id="gridTarifas"></div>
      <div class="card">
        <p class="nota">Se cobra por hora o fracción (mínimo 1 hora). Los <b>minutos de gracia</b> son la tolerancia: si el vehículo pasa de la hora solo esos minutos, no se cobra otra hora. El <b>tope por día</b> es lo máximo que se cobra por cada 24 horas (0 = sin tope).</p>
        <button class="btn verde" onclick="guardarTarifas()">Guardar tarifas</button>
        <div id="msgTarifas" class="aviso"></div>
      </div>
    </section>

    <!-- ================= MENSUALIDADES ================= -->
    <section id="vMens" class="vista">
      <div class="card">
        <h2 id="tituloMens">Nueva mensualidad</h2>
        <form id="formMens">
          <div class="fila">
            <div><label>Placa</label><input id="mPlaca" required></div>
            <div><label>Tipo</label><select id="mTipo"><option value="moto">Moto</option><option value="carro">Carro</option></select></div>
            <div><label>Propietario</label><input id="mProp"></div>
            <div><label>Teléfono</label><input id="mTel"></div>
          </div>
          <div class="fila">
            <div><label>Valor mensual</label><input id="mValor" type="number" min="0"></div>
            <div><label>Desde</label><input id="mIni" type="date"></div>
            <div><label>Vence</label><input id="mFin" type="date" required></div>
            <div><label>Activa</label><select id="mActivo"><option value="1">Sí</option><option value="0">No</option></select></div>
          </div>
          <div class="acciones" style="margin-top:12px">
            <button class="btn verde" type="submit">Guardar</button>
            <button class="btn gris" type="button" onclick="limpiarForm()">Limpiar</button>
          </div>
        </form>
        <div id="msgMens" class="aviso"></div>
      </div>
      <div class="card">
        <input id="buscarMens" placeholder="Buscar placa o propietario..." autocomplete="off">
        <div class="tabla">
          <table>
            <thead><tr><th>Placa</th><th>Tipo</th><th>Propietario</th><th>Teléfono</th><th>Valor</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
            <tbody id="tablaMens"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ================= RECIBO ================= -->
    <section id="vRecibo" class="vista">
      <div class="card">
        <h2>Datos que salen en el recibo</h2>
        <div class="fila">
          <div><label>Nombre del parqueadero</label><input id="cNombre"></div>
          <div><label>NIT</label><input id="cNit"></div>
        </div>
        <div class="fila">
          <div><label>Dirección</label><input id="cDir"></div>
          <div><label>Teléfono</label><input id="cTel"></div>
          <div><label>Ancho del papel</label><select id="cAncho"><option value="58">58 mm</option><option value="80">80 mm</option></select></div>
        </div>
        <label>Mensaje al pie del recibo</label>
        <textarea id="cMsg" rows="2"></textarea>
        <div class="acciones" style="margin-top:12px">
          <button class="btn verde" onclick="guardarConfig()">Guardar</button>
          <button class="btn gris" onclick="pruebaImpresion()">Imprimir recibo de prueba</button>
        </div>
        <div id="msgConfig" class="aviso"></div>
      </div>
    </section>
  </main>

  <script src="/app.js"></script>
  <script>
    exigirSesion('admin');
    const $ = (id) => document.getElementById(id);
    let config = {}, tarifas = [], mensualidades = [], editando = null;

    // ---------- Resumen ----------
    function rango(cual) {
      const hoy = hoyStr();
      let d = hoy, h = hoy;
      if (cual === 'ayer') d = h = sumarDias(hoy, -1);
      if (cual === 'semana') { const dow = new Date(hoy + 'T12:00:00Z').getUTCDay(); d = sumarDias(hoy, -((dow + 6) % 7)); }
      if (cual === 'mes') d = hoy.slice(0, 8) + '01';
      $('desde').value = d; $('hasta').value = h;
      cargarReporte();
    }

    async function cargarReporte() {
      try {
        const r = await api(`/api/admin/reporte?desde=${$('desde').value}&hasta=${$('hasta').value}`);
        const t = r.totales;
        $('kTotal').textContent = pesos(t.total);
        $('kRango').textContent = r.desde === r.hasta ? r.desde : `${r.desde} a ${r.hasta}`;
        $('kMotos').textContent = t.motos; $('kMotosV').textContent = pesos(t.ingresoMotos);
        $('kCarros').textContent = t.carros; $('kCarrosV').textContent = pesos(t.ingresoCarros);
        $('kMens').textContent = t.mensMotos + t.mensCarros; $('kMensD').textContent = `${t.mensMotos} motos · ${t.mensCarros} carros`;
        $('tablaDias').innerHTML = r.dias.map((d) => `<tr><td>${d.fecha}</td><td>${d.motos}</td><td>${pesos(d.ingresoMotos)}</td><td>${d.carros}</td><td>${pesos(d.ingresoCarros)}</td><td><b>${pesos(d.total)}</b></td><td>${d.mensMotos}</td><td>${d.mensCarros}</td><td>${d.mensSalidas}</td></tr>`).join('')
          || '<tr><td colspan="9" class="nota">Sin movimientos en este rango</td></tr>';
        $('tablaDetalle').innerHTML = r.registros.slice().reverse().map((x) => `<tr><td>${x.id}</td><td><b>${esc(x.placa)}</b></td><td>${x.tipo}</td><td>${fechaHora(x.entrada)}</td><td>${fechaHora(x.salida)}</td><td>${duracion(x.minutos || 0)}</td><td>${pesos(x.valor)}</td></tr>`).join('')
          || '<tr><td colspan="7" class="nota">Sin cobros</td></tr>';
        const dentro = await api('/api/dentro');
        $('kDentro').textContent = dentro.registros.length;
      } catch (e) { alert(e.message); }
    }

    // ---------- Tarifas y recibo ----------
    async function cargarConfig() {
      const r = await api('/api/config');
      config = r.config; tarifas = r.tarifas;
      $('gridTarifas').innerHTML = tarifas.map((t) => `<div class="card">
        <h2>${t.tipo === 'moto' ? '🏍️ Moto' : '🚗 Carro'}</h2>
        <label>Valor por hora</label><input type="number" min="0" id="t_${t.tipo}_hora" value="${t.valor_hora}">
        <label>Minutos de gracia</label><input type="number" min="0" id="t_${t.tipo}_gracia" value="${t.minutos_gracia}">
        <label>Tope por día (0 = sin tope)</label><input type="number" min="0" id="t_${t.tipo}_tope" value="${t.tope_dia}">
      </div>`).join('');
      $('cNombre').value = config.nombre; $('cNit').value = config.nit; $('cDir').value = config.direccion;
      $('cTel').value = config.telefono; $('cMsg').value = config.mensaje; $('cAncho').value = config.ancho_papel;
    }

    async function guardarTarifas() {
      try {
        await api('/api/admin/tarifas', { method: 'PUT', body: { tarifas: tarifas.map((t) => ({
          tipo: t.tipo,
          valor_hora: $(`t_${t.tipo}_hora`).value,
          minutos_gracia: $(`t_${t.tipo}_gracia`).value,
          tope_dia: $(`t_${t.tipo}_tope`).value,
        })) } });
        aviso($('msgTarifas'), 'Tarifas guardadas ✔');
        cargarConfig();
      } catch (e) { aviso($('msgTarifas'), e.message, 'error'); }
    }

    function leerConfig() {
      return { nombre: $('cNombre').value, nit: $('cNit').value, direccion: $('cDir').value, telefono: $('cTel').value, mensaje: $('cMsg').value, ancho_papel: $('cAncho').value };
    }
    async function guardarConfig() {
      try { await api('/api/admin/config', { method: 'PUT', body: leerConfig() }); aviso($('msgConfig'), 'Datos guardados ✔'); cargarConfig(); }
      catch (e) { aviso($('msgConfig'), e.message, 'error'); }
    }
    function pruebaImpresion() {
      const c = leerConfig();
      imprimir(reciboEntrada(c, { id: 0, placa: 'ABC123', tipo: 'carro', entrada: new Date().toISOString() }), c.ancho_papel);
    }

    // ---------- Mensualidades ----------
    async function cargarMensualidades() {
      try { mensualidades = (await api('/api/mensualidades')).mensualidades; pintarMens(); }
      catch (e) { aviso($('msgMens'), e.message, 'error'); }
    }
    function pintarMens() {
      const q = $('buscarMens').value.trim().toUpperCase();
      const lista = mensualidades.filter((m) => !q || m.placa.includes(limpiarPlaca(q)) || (m.propietario || '').toUpperCase().includes(q));
      $('tablaMens').innerHTML = lista.map((m) => {
        const estado = !m.activo ? '<span class="chip fuera">Inactiva</span>' : m.vencida ? '<span class="chip vencida">Vencida</span>' : '<span class="chip dentro">Al día</span>';
        return `<tr><td><b>${esc(m.placa)}</b></td><td>${m.tipo}</td><td>${esc(m.propietario)}</td><td>${esc(m.telefono)}</td><td>${pesos(m.valor)}</td><td>${m.fecha_fin}</td><td>${estado}</td>
          <td class="acciones">
            <button class="btn chico verde" onclick="renovar(${m.id})">+1 mes</button>
            <button class="btn chico gris" onclick="editar(${m.id})">Editar</button>
            <button class="btn chico rojo" onclick="eliminar(${m.id})">Eliminar</button>
          </td></tr>`;
      }).join('') || '<tr><td colspan="8" class="nota">Aún no hay mensualidades</td></tr>';
    }
    $('buscarMens').addEventListener('input', pintarMens);

    function limpiarForm() {
      editando = null; $('formMens').reset(); $('tituloMens').textContent = 'Nueva mensualidad';
      $('mIni').value = hoyStr(); $('mFin').value = sumarMes(hoyStr());
    }
    function sumarMes(f) { const d = new Date(f + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); }
    function datosDe(m) {
      return { placa: m.placa, tipo: m.tipo, propietario: m.propietario, telefono: m.telefono, valor: m.valor, fecha_inicio: m.fecha_inicio, fecha_fin: m.fecha_fin, activo: m.activo };
    }

    function editar(id) {
      const m = mensualidades.find((x) => x.id === id); if (!m) return;
      editando = id; $('tituloMens').textContent = 'Editando ' + m.placa;
      $('mPlaca').value = m.placa; $('mTipo').value = m.tipo; $('mProp').value = m.propietario; $('mTel').value = m.telefono;
      $('mValor').value = m.valor; $('mIni').value = m.fecha_inicio; $('mFin').value = m.fecha_fin; $('mActivo').value = m.activo ? '1' : '0';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function renovar(id) {
      const m = mensualidades.find((x) => x.id === id); if (!m) return;
      const base = m.fecha_fin >= hoyStr() ? m.fecha_fin : hoyStr();
      const nueva = sumarMes(base);
      if (!confirm(`¿Renovar ${m.placa} hasta ${nueva}?`)) return;
      try { await api(`/api/admin/mensualidades/${id}`, { method: 'PUT', body: { ...datosDe(m), fecha_fin: nueva, activo: true } }); aviso($('msgMens'), `${m.placa} renovada hasta ${nueva} ✔`); cargarMensualidades(); }
      catch (e) { aviso($('msgMens'), e.message, 'error'); }
    }

    async function eliminar(id) {
      const m = mensualidades.find((x) => x.id === id);
      if (!m || !confirm(`¿Eliminar la mensualidad de ${m.placa}? Se borra también su historial de entradas.`)) return;
      try { await api(`/api/admin/mensualidades/${id}`, { method: 'DELETE' }); cargarMensualidades(); }
      catch (e) { aviso($('msgMens'), e.message, 'error'); }
    }

    $('formMens').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { placa: $('mPlaca').value, tipo: $('mTipo').value, propietario: $('mProp').value, telefono: $('mTel').value,
        valor: $('mValor').value, fecha_inicio: $('mIni').value, fecha_fin: $('mFin').value, activo: $('mActivo').value === '1' };
      try {
        if (editando) await api(`/api/admin/mensualidades/${editando}`, { method: 'PUT', body });
        else await api('/api/admin/mensualidades', { method: 'POST', body });
        aviso($('msgMens'), 'Mensualidad guardada ✔'); limpiarForm(); cargarMensualidades();
      } catch (err) { aviso($('msgMens'), err.message, 'error'); }
    });

    activarPestanas((v) => { if (v === 'vMens') cargarMensualidades(); if (v === 'vResumen') cargarReporte(); });
    limpiarForm();
    cargarConfig().catch((e) => alert(e.message));
    rango('hoy');
  </script>
</body>
</html>
```

---

## Paso 3 — Crear la base de datos en Supabase

1. Entra a https://supabase.com → **New project**. Nombre: `parqueadero`. Pon una contraseña de base de datos (guárdala). Región: la más cercana disponible (ej. *East US*).
2. Cuando termine de crearse, ve a **SQL Editor → New query**, pega **todo** el contenido de `sql/schema.sql` y dale **Run**. Debe decir *Success*.
3. Ve a **Table Editor** y verifica que existen: `tarifas`, `configuracion`, `registros`, `mensualidades`, `movimientos_mensualidad`.
4. Copia las credenciales en **Project Settings → API** (o *API Keys*):
   - **Project URL** → será `SUPABASE_URL`
   - La llave **secreta**: `service_role` (o la nueva *secret key* `sb_secret_...`) → será `SUPABASE_SERVICE_KEY`

> ⚠️ La llave secreta **solo** va en el servidor (`.env` y Render). Nunca en el HTML ni en GitHub. Por eso el SQL activa RLS: con la llave pública nadie puede leer los datos.

---

## Paso 4 — Probar en tu PC

1. Copia `.env.example` y renómbralo a `.env`. Llena los valores:

```bash
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_KEY=tu_llave_secreta
JWT_SECRET=un-texto-largo-y-aleatorio
ADMIN_USER=admin
ADMIN_PASS=una-clave-fuerte
OPERADOR_USER=caja
OPERADOR_PASS=otra-clave
PORT=3000
```

Para generar un `JWT_SECRET` aleatorio:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2. Arranca el servidor:

```bash
npm run dev
```

Debe decir `Parqueadero listo en http://localhost:3000`. (`npm run dev` se reinicia solo cuando guardas cambios.)

3. Pruebas en el navegador (Chrome):

| Prueba | Qué debe pasar |
|---|---|
| Abrir http://localhost:3000 y entrar con `admin` | Abre el panel del administrador |
| Pestaña **Datos del recibo** → llenar nombre/NIT → Guardar → *Imprimir recibo de prueba* | Sale el diálogo de impresión con el recibo angosto |
| Pestaña **Tarifas** → cambiar valores → Guardar | Mensaje "Tarifas guardadas" |
| Pestaña **Mensualidades** → crear una placa, ej. `XYZ98A` moto | Aparece en la lista |
| *Ir a la caja* → Entrada → escribir `ABC123` | Se marca **Carro** solo (las placas tipo `ABC12D` se marcan **Moto**) |
| Registrar e imprimir | Sale el recibo y aparece en "Vehículos dentro" |
| Registrar otra vez `ABC123` | Error: ya está dentro |
| Salida → `ABC123` → Buscar | Muestra tiempo y valor → *Cobrar y dar salida* |
| Entrada → `XYZ98A` (mensualidad) | Avisa que es mensualidad, **no imprime**, ofrece *Marcar entrada* |
| Caja → pestaña **Mensualidades** → Entró / Salió | Se actualizan los contadores y "Movimientos de hoy" |
| Admin → **Resumen** → Hoy | Muestra lo cobrado, motos, carros y mensualidades |
| Cerrar sesión y entrar con `caja` | Solo ve la caja; si intenta abrir `/admin.html` lo devuelve |

Para probar cobros de varias horas sin esperar, en Supabase → Table Editor → `registros`, edita la columna `entrada` de un vehículo que esté dentro y ponle una hora anterior.

Para detener el servidor: `Ctrl + C`.

---

## Paso 5 — Subir a GitHub (repositorio privado)

1. En GitHub → **New repository** → nombre `parqueadero` → **Private** → *Create* (sin README).
2. En la terminal de VS Code:

```bash
git init
git add .
git commit -m "Versión inicial del parqueadero"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/parqueadero.git
git push -u origin main
```

3. Verifica en GitHub que **NO** aparece el archivo `.env` ni la carpeta `node_modules` (el `.gitignore` los excluye). Si apareció `.env`, cambia de inmediato la llave en Supabase.

---

## Paso 6 — Publicar en Render (gratis)

1. Render → **New + → Web Service** → conecta tu GitHub y elige el repo privado `parqueadero` (si no aparece: *Configure account* y dale acceso a ese repo).
2. Configuración:

| Campo | Valor |
|---|---|
| Name | `parqueadero-nombrecliente` (será parte de la URL) |
| Language / Runtime | Node |
| Branch | main |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

3. En **Environment Variables** agrega las mismas del `.env` **excepto `PORT`** (Render la pone sola): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `JWT_SECRET`, `ADMIN_USER`, `ADMIN_PASS`, `OPERADOR_USER`, `OPERADOR_PASS`.
4. **Create Web Service**. Espera a que diga *Live* y abre la URL `https://parqueadero-nombrecliente.onrender.com`.
5. Prueba `https://TU-URL.onrender.com/health` → debe responder `ok`.

Cada vez que hagas cambios: `git add .` → `git commit -m "..."` → `git push` y Render redespliega solo.

---

## Paso 7 — Mantenerlo despierto con UptimeRobot

El plan gratis de Render **apaga el servicio tras 15 minutos sin visitas** y la siguiente visita tarda cerca de un minuto en arrancar. Supabase gratis **pausa el proyecto tras 7 días sin actividad**. El monitor resuelve ambas cosas porque `/health` también consulta la base de datos.

1. UptimeRobot → **Add New Monitor**.
2. Tipo: **HTTP(s)**. Nombre: `Parqueadero`. URL: `https://TU-URL.onrender.com/health`.
3. Intervalo: **5 minutos** (el mínimo del plan gratis).
4. Alertas: pon tu correo (y el del parqueadero) para enterarte si se cae.

Cuentas: un solo servicio prendido 24/7 usa ~744 horas al mes y Render da 750 gratis por cuenta. **No pongas otro servicio gratis en la misma cuenta de Render** con monitor, o se acaban las horas a mitad de mes. Por eso conviene la cuenta de Render a nombre del correo del parqueadero.

---

## Paso 8 — Instalar en el PC del parqueadero

1. **Impresora térmica** (58 u 80 mm): instala el driver del fabricante, déjala como **predeterminada** en Windows y en sus preferencias pon el tamaño de papel correcto (ej. 58 × 3276 mm o "rollo").
2. En el panel del administrador → **Datos del recibo** → elige el ancho (58 u 80) y haz una prueba.
3. **Imprimir sin que salga el diálogo** (recomendado para la caja): crea un acceso directo de Chrome en el escritorio, clic derecho → *Propiedades* → en *Destino* agrega al final:

```text
--kiosk-printing https://TU-URL.onrender.com/caja.html
```

Queda algo como: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://TU-URL.onrender.com/caja.html`

Cierra **todas** las ventanas de Chrome y ábrelo desde ese acceso directo: los recibos se imprimen directo en la impresora predeterminada. La primera vez, en el diálogo de impresión desmarca *Encabezados y pies de página* y pon márgenes *Ninguno*; Chrome lo recuerda.

4. Opcional: en Chrome → menú → *Transmitir, guardar y compartir → Instalar página como app*, para que se vea como un programa.

---

## Cómo funciona el cobro y los reportes

- **Hora de Colombia** en todo (America/Bogota).
- El valor se calcula en el servidor al momento de **Cobrar y dar salida**, con las tarifas vigentes.
- Los reportes agrupan por la **fecha de salida** (el día en que se cobró). Los botones *Hoy / Ayer / Esta semana / Este mes* o un rango libre.
- Mensualidades: el reporte cuenta las **entradas** por día (motos y carros) y las salidas. Una mensualidad vencida no bloquea la entrada: se registra como visitante y la caja ve el aviso.

## Seguridad y mantenimiento

- Cambiar claves de usuarios: en Render → *Environment* → edita `ADMIN_PASS` / `OPERADOR_PASS` → *Save* (se redespliega).
- Si quieres cerrar todas las sesiones abiertas, cambia `JWT_SECRET`.
- Respaldo: el plan gratis de Supabase no incluye backups automáticos. De vez en cuando: Table Editor → cada tabla → *Export to CSV*.
- Espacio: 500 MB en Supabase gratis alcanzan para varios años de registros de un parqueadero.

## Ideas para cobrar como mejoras después

- Cuadre de caja por turno y por operador.
- Exportar reportes a Excel.
- Registro de **gastos** del día (si el dueño también quiere restarlos).
- Pago y vencimiento de mensualidades con historial.
- Varios operadores con su propio usuario.
