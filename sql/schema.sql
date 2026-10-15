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
