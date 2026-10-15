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

// ---------- Formatos ----------
const ZONA = 'America/Bogota';
const pesos = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n || 0)).toLocaleString('es-CO');
const fechaHora = (d) => new Date(d).toLocaleString('es-CO', { timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const hora = (d) => new Date(d).toLocaleTimeString('es-CO', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: true });
const hoyStr = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
function sumarDias(f, n) { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function duracion(min) {
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d ? d + ' d' : '', h ? h + ' h' : '', m + ' min'].filter(Boolean).join(' ');
}
const minutosDesde = (d) => Math.max(0, Math.floor((Date.now() - new Date(d)) / 60000));
const limpiarPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function aviso(el, texto, tipo = 'ok') { el.className = 'aviso ' + tipo; el.textContent = texto; }

// ---------- Tipos de vehículo (vienen de la tabla tarifas) ----------
let TIPOS = []; // se llena con lo que devuelve /api/config
const ICONOS = { moto: '🏍️', carro: '🚗', bicicleta: '🚲' };
const icono = (tipo) => ICONOS[tipo] || '🚙';
const nombreTipo = (tipo) => (TIPOS.find((t) => t.tipo === tipo) || {}).nombre || tipo;
const tiposActivos = () => TIPOS.filter((t) => t.activo);
function detectarTipo(placa) {
  let t = null;
  if (/^[A-Z]{3}\d{3}$/.test(placa)) t = 'carro';
  else if (/^[A-Z]{3}\d{2}[A-Z]?$/.test(placa)) t = 'moto';
  return tiposActivos().some((x) => x.tipo === t) ? t : null;
}
// { moto: { n: 3, valor: 5000 } } -> "3 Moto · 1 Carro"
function textoDetalle(detalle, conValor = false) {
  return Object.entries(detalle || {}).map(([t, d]) => `${d.n} ${nombreTipo(t)}${conValor ? ' ' + pesos(d.valor) : ''}`).join(' · ') || '—';
}

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
    <p class="c">${esc(nombreTipo(r.tipo).toUpperCase())}</p><hr>
    <p>Entrada: ${fechaHora(r.entrada)}</p><hr>
    <p class="c">${esc(cfg.mensaje)}</p>`;
}

function reciboSalida(cfg, r) {
  return `${encabezadoRecibo(cfg)}
    <p class="c">RECIBO DE PAGO N° ${r.id}</p>
    <p class="c g">${esc(r.placa)}</p>
    <p class="c">${esc(nombreTipo(r.tipo).toUpperCase())}</p><hr>
    <p>Entrada: ${fechaHora(r.entrada)}</p>
    <p>Salida:  ${fechaHora(r.salida)}</p>
    <p>Tiempo:  ${duracion(r.minutos)}</p><hr>
    <p class="c t">TOTAL ${pesos(r.valor)}</p><hr>
    <p class="c">${esc(cfg.mensaje)}</p>`;
}

function reciboCierre(cfg, c) {
  const lineas = Object.entries(c.detalle || {}).map(([t, d]) => `<p>${esc(nombreTipo(t))}: ${d.n} = ${pesos(d.valor)}</p>`).join('');
  return `${encabezadoRecibo(cfg)}
    <p class="c"><b>CIERRE DE CAJA N° ${c.id}</b></p>
    <p>Fecha:  ${fechaHora(c.fecha)}</p>
    <p>Cajero: ${esc(c.usuario)}</p>
    ${c.desde ? `<p>Desde:  ${fechaHora(c.desde)}</p><p>Hasta:  ${fechaHora(c.hasta)}</p>` : ''}<hr>
    ${lineas}
    <p>Vehículos cobrados: ${c.cantidad}</p>
    <p>Mensualidades (entradas hoy): ${c.mens_entradas}</p><hr>
    <p><b>TOTAL SISTEMA: ${pesos(c.total_sistema)}</b></p>
    <p>Efectivo contado: ${pesos(c.efectivo_contado)}</p>
    <p><b>Diferencia: ${pesos(c.diferencia)}</b></p>
    ${c.observaciones ? `<hr><p>Obs: ${esc(c.observaciones)}</p>` : ''}
    <br><br><p>Firma cajero: ______________</p><br><br><p>Firma admin: _______________</p>`;
}