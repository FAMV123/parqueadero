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
// "2026-01-31" + 1 mes = "2026-02-28" (igual que en el servidor)
function sumarMes(f) {
  const [y, m, d] = f.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, ultimo))).toISOString().slice(0, 10);
}
function duracion(min) {
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d ? d + ' d' : '', h ? h + ' h' : '', m + ' min'].filter(Boolean).join(' ');
}
const minutosDesde = (d) => Math.max(0, Math.floor((Date.now() - new Date(d)) / 60000));
const limpiarPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
const soloNumero = (t) => Number(String(t || '').replace(/[^\d]/g, '')) || 0; // "60.000" -> 60000
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function aviso(el, texto, tipo = 'ok') { el.className = 'aviso ' + tipo; el.textContent = texto; }

// ---------- Ventanas propias del sistema (reemplazan alert / confirm / prompt del navegador) ----------
// Devuelve una promesa: lo que entregue alAceptar (o true), y null si se cancela.
function abrirVentana({ icono = 'ℹ️', titulo = '', cuerpo = '', boton = 'Aceptar', tipoBoton = '', cancelar = 'Cancelar', alAceptar, alAbrir }) {
  return new Promise((resolve) => {
    const fondo = document.createElement('div');
    fondo.className = 'modal-fondo';
    fondo.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-cab"><span class="modal-icono">${icono}</span><h3>${esc(titulo)}</h3></div>
      <div class="modal-cuerpo">${cuerpo}</div>
      <div class="modal-error" hidden></div>
      <div class="modal-botones">
        ${cancelar ? `<button type="button" class="btn gris" data-r="no">${esc(cancelar)}</button>` : ''}
        <button type="button" class="btn ${tipoBoton}" data-r="si">${esc(boton)}</button>
      </div></div>`;
    const anterior = document.activeElement;
    document.body.appendChild(fondo);
    const modal = fondo.querySelector('.modal');
    const error = fondo.querySelector('.modal-error');
    let cerrada = false;
    const cerrar = (valor) => {
      if (cerrada) return;
      cerrada = true;
      document.removeEventListener('keydown', teclas, true);
      fondo.classList.add('saliendo');
      setTimeout(() => fondo.remove(), 150);
      if (anterior && anterior.focus) anterior.focus();
      resolve(valor);
    };
    const aceptar = () => {
      if (!alAceptar) return cerrar(true);
      const r = alAceptar(modal);
      if (typeof r === 'string') { error.textContent = r; error.hidden = false; return; } // texto = error, no cierra
      cerrar(r);
    };
    function teclas(e) {
      if (e.key === 'Escape') { e.preventDefault(); cerrar(null); }
      else if (e.key === 'Enter' && e.target.dataset.r !== 'no') { e.preventDefault(); aceptar(); }
    }
    document.addEventListener('keydown', teclas, true);
    fondo.addEventListener('click', (e) => { if (e.target === fondo) cerrar(null); });
    modal.querySelector('[data-r="si"]').addEventListener('click', aceptar);
    const btnNo = modal.querySelector('[data-r="no"]');
    if (btnNo) btnNo.addEventListener('click', () => cerrar(null));
    if (alAbrir) alAbrir(modal);
    (modal.querySelector('.modal-cuerpo input') || modal.querySelector('[data-r="si"]')).focus();
  });
}

// Pregunta Sí / No. Devuelve true o false.
const confirmar = (opciones) => abrirVentana(opciones).then((r) => r === true);

// Mensaje con un solo botón
const alerta = (mensaje, titulo = 'Atención') =>
  abrirVentana({ icono: '⚠️', titulo, cuerpo: `<p>${esc(mensaje)}</p>`, cancelar: '', boton: 'Entendido' });

// Lista de datos dentro de la ventana: [['Tipo', 'Moto'], ['Valor', '$60.000', 'grande']] (valores ya escapados)
const datosVentana = (filas) =>
  `<div class="modal-datos">${filas.map(([k, v, clase]) => `<div><span>${esc(k)}</span><b class="${clase || ''}">${v}</b></div>`).join('')}</div>`;

// Placa amarilla para mostrar dentro de la ventana
const placaVentana = (placa) => `<span class="modal-placa">${esc(placa)}</span>`;

// Pide un valor en pesos (con separador de miles) y, si se indica, una opción. Devuelve { valor, opcion } o null.
function pedirValor({ icono = '💵', titulo, cuerpo = '', etiqueta = 'Valor recibido', valor = '', boton = 'Aceptar', tipoBoton = 'verde', opciones }) {
  const formato = (n) => (n ? Number(n).toLocaleString('es-CO') : '');
  const radios = opciones ? `<div class="modal-opciones">${opciones.map((o, i) => `
    <label class="opcion"><input type="radio" name="opcionVentana" value="${esc(o.valor)}" ${i === 0 ? 'checked' : ''}>
      <span><b>${esc(o.titulo)}</b>${o.detalle ? `<small>${esc(o.detalle)}</small>` : ''}</span></label>`).join('')}</div>` : '';
  return abrirVentana({
    icono, titulo, boton, tipoBoton,
    cuerpo: `${cuerpo}<label>${esc(etiqueta)}</label>
      <input class="modal-valor" type="text" inputmode="numeric" autocomplete="off" value="${formato(valor)}">${radios}`,
    alAbrir: (m) => {
      const inp = m.querySelector('.modal-valor');
      inp.addEventListener('input', () => { inp.value = formato(soloNumero(inp.value)); });
      setTimeout(() => inp.select(), 0);
    },
    alAceptar: (m) => {
      const v = soloNumero(m.querySelector('.modal-valor').value);
      if (!v) return 'Escriba el valor recibido';
      const op = m.querySelector('input[name="opcionVentana"]:checked');
      return { valor: v, opcion: op ? op.value : null };
    },
  });
}

// ---------- Tipos de vehículo (vienen de la tabla tarifas) ----------
let TIPOS = []; // se llena con lo que devuelve /api/config
const ICONOS = { moto: '🏍️', carro: '🚗', bicicleta: '🚲' };
const icono = (tipo) => ICONOS[tipo] || '🚙';
const nombreTipo = (tipo) => (TIPOS.find((t) => t.tipo === tipo) || {}).nombre || tipo;
const valorMesDe = (tipo) => (TIPOS.find((t) => t.tipo === tipo) || {}).valor_mes || 0;
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

function reciboMensualidad(cfg, p) {
  return `${encabezadoRecibo(cfg)}
    <p class="c"><b>PAGO DE MENSUALIDAD N° ${p.id}</b></p>
    <p class="c g">${esc(p.placa)}</p>
    <p class="c">${esc(nombreTipo(p.tipo).toUpperCase())}</p><hr>
    ${p.propietario ? `<p>Cliente: ${esc(p.propietario)}</p>` : ''}
    <p>Fecha pago: ${fechaHora(p.fecha)}</p>
    <p><b>Válida hasta: ${p.hasta}</b></p><hr>
    <p class="c t">TOTAL ${pesos(p.valor)}</p><hr>
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
    ${c.mens_pagos ? `<p>Pagos mensualidad: ${c.mens_pagos} = ${pesos(c.mens_valor)}</p>` : ''}
    <p>Vehículos cobrados: ${c.cantidad}</p>
    <p>Mensualidades (entradas hoy): ${c.mens_entradas}</p><hr>
    <p><b>TOTAL SISTEMA: ${pesos(c.total_sistema)}</b></p>
    <p>Efectivo contado: ${pesos(c.efectivo_contado)}</p>
    <p><b>Diferencia: ${pesos(c.diferencia)}</b></p>
    ${c.observaciones ? `<hr><p>Obs: ${esc(c.observaciones)}</p>` : ''}
    <br><br><p>Firma cajero: ______________</p><br><br><p>Firma admin: _______________</p>`;
}

// ---------- Encabezado: letrero P, nombre del parqueadero y reloj ----------
(function decorarEncabezado() {
  const header = document.querySelector('header');
  const h1 = header && header.querySelector('h1');
  if (!h1) return;
  const titulo = h1.textContent.replace('🅿️', '').trim(); // "Caja" o "Panel del administrador"
  h1.innerHTML = `<span class="logo">P</span><span><span id="marcaNombre">Parqueadero</span><small>${esc(titulo)}</small></span>`;
  const reloj = document.createElement('div');
  reloj.className = 'reloj-top';
  h1.after(reloj);
  const tic = () => { reloj.textContent = new Date().toLocaleTimeString('es-CO', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: true }); };
  tic(); setInterval(tic, 15000);
  fetch('/api/marca').then((r) => r.json()).then((d) => { if (d.nombre) document.getElementById('marcaNombre').textContent = d.nombre; }).catch(() => {});
})();