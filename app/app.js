/* MTZ Técnico Franquicias — app central del técnico de mantenimiento.
   Login con código personal de 4 dígitos (mismos códigos que el Generador
   de Informes). La sesión vive mientras la app esté abierta (sessionStorage);
   al cerrarla hay que volver a ingresar el código, pero el registro de la
   jornada sigue (localStorage). Desde acá se abre el Generador ya identificado
   y el Localizador de Locales. Los avisos de Telegram los decide el servidor. */
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
let SERVER = location.origin;   // fallback: app servida desde el propio tunel
// Cuando la app vive en GitHub Pages, api_base.json (junto a index.html) apunta
// a la URL actual del tunel; se renueva sin reinstalar la PWA.
async function cargarApiBase() {
  try {
    const r = await fetch('api_base.json', { cache: 'no-store' });
    const d = await r.json();
    if (d && typeof d.api === 'string') SERVER = d.api.replace(/\/+$/, '');
  } catch (e) { /* 404 o sin red: queda el fallback */ }
}
const INTERVAL_MS = 30 * 60 * 1000;          // ping cada 30 minutos
const URL_GENERADOR = 'https://cristianmerlo.github.io/Generador_de_Informes_online/';
const URL_LOCALIZADOR = 'https://cristianmerlo.github.io/localizador-de-locales/';
const SES_KEY = 'mtz_sesion';
const app = $('#app');

// ---------- sesión (código de 4 dígitos, mismos que el Generador) ----------
let SES = null;
try { SES = JSON.parse(localStorage.getItem(SES_KEY) || 'null'); } catch (e) { SES = null; }
if (SES && !SES.codigo) SES = null;
// brazalete: sin tk o vencido -> hay que volver a poner el código (1x por día)
if (SES && !SES.prueba && (!SES.tk || (SES.vence && SES.vence < nowLocal()))) SES = null;
let TC = SES ? SES.codigo : '';

const S = Object.assign({
  activo: false, inicio: null, fin: null, pings: 0, ultimo: null,
  ultimoOk: true, lat: null, lng: null, viaje: null, viajes: [], dueno: null,
}, JSON.parse(localStorage.getItem('ronda_live') || 'null') || {});
let timer = null;

function save(){ localStorage.setItem('ronda_live', JSON.stringify(S)); }
function fmt(iso){ return iso ? iso.slice(11,16) : '—'; }
// hora local en formato ISO sin zona (el server trabaja en ART -03; usar UTC
// corría los relojes 3 horas adelante en el celular).
function nowLocal(){ const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function sesionOK(t, cod){ return t && String(t.cod) === String(cod); }
function abrirSesion(t){
  SES = { codigo: t.codigo, nombre: t.nombre, cod: t.cod || '', tk: t.tk || '', vence: t.vence || '', prueba: !!t.prueba };
  TC = t.codigo;
  localStorage.setItem(SES_KEY, JSON.stringify(SES));
  localStorage.setItem('ronda_tc', TC);
  $('#salirBtn').style.display = '';
  if (S.dueno && S.dueno !== TC) { Object.assign(S, { activo:false, inicio:null, fin:null, pings:0, ultimo:null, viaje:null, viajes:[], dueno:null }); save(); }
}
function cerrarSesion(){
  clearInterval(timer);
  localStorage.removeItem(SES_KEY);
  sessionStorage.removeItem(SES_KEY); // limpieza de la época pre-brazalete
  SES = null; TC = '';
  $('#salirBtn').style.display = 'none';
  $('#ovCfg').classList.remove('on');
  render();
}

let toastT = null;
function toast(msg, ms){
  if (!msg) return;
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 3200);
}
// si el servidor/túnel devuelve una página de error (HTML), mostrar un resumen amigable
function safeErr(t){
  t = String(t || '').trim();
  if (!t) return 'sin respuesta';
  if (t[0] === '<' || /<!DOCTYPE|<html/i.test(t)) return 'el servidor devolvió una página de error (revisá el server o reintentá)';
  return t.slice(0, 120);
}

// ---------- ubicación real (coarse) ----------
function ubicacion() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: +p.coords.latitude.toFixed(4), lng: +p.coords.longitude.toFixed(4),
                   prec: Math.round(p.coords.accuracy || 0) }),
      () => res(null),
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 15000 });
  });
}

const PROTEGIDAS = ['/p', '/ping', '/inicio', '/fin', '/viaje', '/soporte', '/admin', '/reporte', '/enviar'];
async function api(path, opts) {
  if (SES) {
    const p = path.split('?')[0];
    if (PROTEGIDAS.includes(p)) path += (path.includes('?') ? '&' : '?') + 'tk=' + encodeURIComponent(SES.tk || '');
  }
  try {
    const r = await fetch(SERVER + path, opts || { cache: 'no-store' });
    const t = (await r.text()).slice(0, 120);
    if (r.status === 401 && /sesi/.test(t) && SES && !SES.prueba) {
      cerrarSesion();                      // brazalete vencido: vuelve al login solito
      toast('🔒 Se venció tu sesión — poné tu código de nuevo', 5000);
    }
    return { ok: r.ok, status: r.status, text: t };
  } catch (e) { return { ok: false, status: 0, text: 'sin conexión' }; }
}

// ---------- ping ----------
// Los pings se siguen enviando siempre; solo el técnico los dispara con CUALQUIER
// acción (llegada, viaje, herramientas, finalizar) además del ciclo de 30 min.
// Motivos 'auto'/'periódico' son silenciosos; 'manual'/'llegada' muestran aviso.
let pingVolando = false;
async function enviarPing(motivo) {
  if (pingVolando) return;                 // no amontonar pings con toques seguidos
  pingVolando = true;
  const ruidoso = motivo === 'manual' || motivo === 'llegada';
  try {
    const u = await ubicacion();
    if (u) { S.lat = u.lat; S.lng = u.lng; S.prec = u.prec; }
    if (S.lat == null) {
      S.ultimoOk = false; save();
      if (ruidoso) { render(); toast('⚠️ Sin permiso de ubicación: reintentá desde Ajustes del navegador'); }
      return;
    }
    const ev = motivo === 'llegada' ? '&ev=llegada' : '';
    const r = await api(`/p?tc=${encodeURIComponent(TC)}&lat=${S.lat}&lng=${S.lng}${ev}`);
    S.ultimo = nowLocal();
    S.ultimoOk = r.ok;
    if (r.ok) {
      S.pings++; save(); render();
      if (motivo === 'llegada') toast('✅ Llegada registrada — ya avisé mi posición');
      else if (motivo === 'manual') toast('📡 Ubicación enviada');
      // bandera REC del server: jornada abierta después de las 19 h → recordatorio (1x por día)
      if (/REC/.test(r.text)) {
        const hoy = nowLocal().slice(0, 10);
        if (localStorage.getItem('ronda_rec') !== hoy) {
          localStorage.setItem('ronda_rec', hoy);
          toast('⏰ Tip: cuando termines, deslizá para finalizar la jornada', 6000);
        }
      }
    }
    else { save(); render(); if (ruidoso) toast('El ping no se envió: ' + safeErr(r.text)); }
  } finally { pingVolando = false; }
}
function pingAuto(){ if (TC && SES) enviarPing('auto'); }  // toque = actualización de posición, sin molestar

// ---------- acciones ----------
async function iniciar() {
  if (!TC) { render(); return; }
  await ubicacion();                      // pide permiso de ubicación con el toque
  const r = await api(`/inicio?tc=${encodeURIComponent(TC)}`);
  if (!r.ok && r.status !== 0) { toast('El servidor respondió: ' + r.text); return; }
  Object.assign(S, { activo: true, inicio: nowLocal(), fin: null,
                    pings: 0, viaje: null, viajes: [], dueno: TC });
  save(); render(); pingLoop(true);
  toast('🟢 Jornada iniciada — el grupo ya fue avisado');
}

function pingLoop(inmediato) {
  clearInterval(timer);
  if (!S.activo || !TC) return;
  if (inmediato) enviarPing('inicio');
  timer = setInterval(() => enviarPing('periódico'), INTERVAL_MS);
}

async function cerrar() {
  clearInterval(timer);
  const r = await api(`/fin?tc=${encodeURIComponent(TC)}`);
  S.activo = false; S.fin = nowLocal(); save(); render();
  if (r.ok) $('#ovRep').classList.add('on');
  else toast('No se pudo cerrar la jornada: ' + safeErr(r.text));
}

async function enviarReporte() {
  const tareas = $('#repTareas').value.trim(), pend = $('#repPend').value.trim();
  if (!tareas) { $('#repTareas').focus(); return; }
  const body = new URLSearchParams({ tareas, pendientes: pend }).toString();
  const r = await api(`/reporte?tc=${encodeURIComponent(TC)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  $('#ovRep').classList.remove('on');
  $('#repTareas').value = ''; $('#repPend').value = '';
  if (r.ok) {
    app.innerHTML = `<div class="card ok-big"><div class="b">✅</div>
      <h2 style="color:var(--ok);margin-top:8px">Jornada enviada</h2>
      <p class="mut" style="margin-top:8px">El consolidado con tus permanencias ya salió al supervisor. ¡Buen trabajo!</p>
      <button class="big gho" id="nuevoDia" style="margin-top:18px">Comenzar un nuevo día</button></div>`;
    $('#nuevoDia').onclick = () => { localStorage.removeItem('ronda_live'); location.reload(); };
  } else toast('El reporte no se envió: ' + safeErr(r.text));
}

async function enviarViaje(destino) {
  const r = await api(`/viaje?tc=${encodeURIComponent(TC)}&dest=${encodeURIComponent(destino)}`);
  if (r.ok) {
    const L = r.text.replace('viaje registrado hacia ', '');
    S.viaje = L; S.viajes.push(L); save(); render();
    toast('🚐 Aviso enviado al grupo: en camino a ' + L);
  } else if (r.status === 404) {
    toast('No encontré ese local. Elegilo de la lista o probá con la sigla.');
  } else toast('Error: ' + r.text);
}

async function enviarSoporte(destino) {
  const r = await api(`/soporte?tc=${encodeURIComponent(TC)}&dest=${encodeURIComponent(destino)}`);
  if (r.ok) {
    toast(r.text.startsWith('soporte ya') ? '🖥️ Ya lo habías anunciado hoy' : '🖥️ Aviso enviado al grupo: dando soporte remoto');
  } else if (r.status === 404) {
    toast('No encontré ese local. Elegilo de la lista o probá con la sigla.');
  } else toast('Error: ' + r.text);
}

// ---------- técnicos (para el login) ----------
let TECNICOS = [];
async function cargarTecnicos(){
  try { const r = await fetch(SERVER + '/tecnicos', { cache: 'no-store' }); const l = await r.json();
        if (Array.isArray(l) && l.length) TECNICOS = l; }
  catch (e) { /* sin red: vacío */ }
}

// ---------- selector de local ("Voy hacia" / "Soporte remoto") ----------
let LOCALES = null;
let selectorModo = 'viaje';
async function cargarLocales() {
  if (LOCALES && LOCALES.length) return LOCALES;
  try {
    const r = await fetch(SERVER + '/locales', { cache: 'no-store' });
    if (r.ok) LOCALES = await r.json();
  } catch (e) { /* sin red: vacío */ }
  return LOCALES || [];
}

function asegurarViajeOverlay() {
  if ($('#ovViaje')) return $('#ovViaje');
  const d = document.createElement('div');
  d.className = 'overlay'; d.id = 'ovViaje';
  d.innerHTML = `<div class="modal">
    <h2 style="margin:0 0 4px" id="selTitulo"></h2>
    <p class="mut" style="margin:0;font-size:13px" id="selDesc"></p>
    <input id="viajeTxt" placeholder="Buscar local, ciudad o sigla (ej: ramos, FSJU)…" autocapitalize="characters">
    <div class="zona" id="viajeLista" style="margin-top:12px"></div>
    <button class="btn gho" style="width:100%;margin-top:12px" id="viajeCancel">Cancelar</button></div>`;
  document.body.appendChild(d);
  d.querySelector('#viajeCancel').onclick = () => d.classList.remove('on');
  d.querySelector('#viajeTxt').addEventListener('input', (e) => pinteLista(e.target.value));
  return d;
}

function abrirSelector(modo) {
  selectorModo = modo;
  const d = asegurarViajeOverlay();
  const soporte = modo === 'soporte';
  d.querySelector('#selTitulo').innerHTML = soporte
    ? '<i class="fa-solid fa-headset" style="color:var(--mostaza)"></i> Doy soporte remoto a…'
    : '<i class="fa-solid fa-van-shuttle" style="color:#5aa9e6"></i> Voy hacia…';
  d.querySelector('#selDesc').textContent = soporte
    ? 'Avisás al grupo que estás atendiendo ese local a distancia.'
    : 'Avisás al grupo ahora; la llegada la confirma tu celular solo.';
  cargarLocales().then(() => { pinteLista(''); const inp = $('#viajeTxt'); if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 80); } });
  d.classList.add('on');
}

function pinteLista(filtroTxt) {
  const box = document.querySelector('#viajeLista');
  if (!box) return;
  box.innerHTML = '';
  const f = norm(filtroTxt);
  const recientes = (S.viajes || []).map(norm);
  const hits = (LOCALES || []).filter((L) => !f || norm(L.nombre).includes(f) || norm(L.localidad).includes(f)
              || norm(L.sigla).includes(f) || (L.alias || []).some((a) => norm(a).includes(f)));
  const sel = (L) => { document.querySelector('#ovViaje').classList.remove('on');
    if (selectorModo === 'soporte') enviarSoporte(L.sigla); else enviarViaje(L.sigla); };
  for (const L of hits.slice(0, 40)) {
    const b = document.createElement('button');
    const rec = recientes.includes(norm(L.nombre)) || recientes.includes(L.sigla.toLowerCase());
    if (rec) b.className = 'rec';
    b.innerHTML = `<i class="fa-solid ${rec ? 'fa-rotate-right' : 'fa-location-dot'}"></i>
      <span><b>${esc(L.nombre)}</b> · ${esc(L.localidad || L.sigla)}
      <span class="mut" style="font-size:12px">[${esc(L.sigla)}]</span>
      ${L.direccion ? `<br><span class="mut" style="font-size:11px">📍 ${esc(L.direccion)}</span>` : ''}</span>`;
    b.onclick = () => sel(L);
    box.appendChild(b);
  }
  if (!hits.length) {
    const p = document.createElement('div');
    p.className = 'note';
    p.textContent = 'Sin coincidencias. Probá con otra palabra o la sigla del local.';
    box.appendChild(p);
  }
}

// ---------- slide-to-confirm (finalizar sin toques accidentales) ----------
function montarSlideFin(onDone) {
  const track = $('#slideFinTrack'), handle = $('#finHandle'), fill = $('#finFill'), lbl = $('#finLbl');
  if (!track) return;
  const DONE = 0.92;
  let x0 = null, pct = 0, disparado = false;
  const anchoMovil = () => Math.max(1, track.clientWidth - handle.offsetWidth - 12);
  const setP = (p) => {
    pct = Math.max(0, Math.min(1, p));
    handle.style.left = (6 + pct * anchoMovil()) + 'px';
    fill.style.width = (pct * 100) + '%';
    lbl.style.opacity = String(1 - pct * 0.9);
  };
  handle.addEventListener('pointerdown', (e) => {
    if (disparado) return;
    x0 = e.clientX; handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (x0 == null || disparado) return;
    setP((e.clientX - x0) / anchoMovil());
    if (pct >= DONE) {
      disparado = true; x0 = null; setP(1); track.classList.add('done');
      lbl.textContent = '✅ Finalizando…';
      setTimeout(onDone, 250);
    }
  });
  const suelta = () => { if (x0 != null && !disparado) { x0 = null; setP(0); } };
  handle.addEventListener('pointerup', suelta);
  handle.addEventListener('pointercancel', suelta);
  setP(0);
}

// ---------- render ----------
function renderLogin() {
  const sugerido = localStorage.getItem('ronda_tc') || '';
  app.innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 6px">¡Bienvenido! 👋</h2>
      <p class="mut" style="margin:0">Ingresá tu técnico y tu <b>código personal de 4 dígitos</b>
      (el mismo del Generador de informes).</p>
    </div>
    <div class="card">
      <label>Vos sos…</label>
      <div class="tecchips" id="lgTecnicos"></div>
      <label>Tu código de 4 dígitos</label>
      <input id="lgCod" inputmode="numeric" maxlength="4" placeholder="0000" autocomplete="off">
      <button class="btn prim" id="lgGo">Ingresar</button>
      <p class="note" id="lgMsg"></p>
      <p class="note"><a href="#" id="lgTest" style="color:var(--mut)">¿Pruebas? escribir otro código de técnico</a></p>
      <div id="lgTestBox" style="display:none">
        <input id="lgTestTc" placeholder="Ej: PRUEBA" autocapitalize="characters">
        <button class="btn gho" id="lgTestGo" style="width:100%;margin-top:8px">Entrar en modo prueba</button>
      </div>
    </div>`;
  let selCod = sugerido;
  const d = $('#lgTecnicos');
  if (!TECNICOS.length) {
    d.innerHTML = '<span class="note">(sin lista de técnicos: chequeá la conexión o entrá en modo prueba)</span>';
  } else {
    d.innerHTML = TECNICOS.map((t) =>
      `<button data-c="${esc(t.codigo)}" class="${selCod === t.codigo ? 'sel' : ''}">${esc(t.nombre)}</button>`).join('');
    d.querySelectorAll('button').forEach((b) => { b.onclick = () => {
      selCod = b.dataset.c;
      d.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
      $('#lgMsg').textContent = '';
    }; });
  }
  $('#lgCod').addEventListener('input', function(){ this.value = this.value.replace(/\D/g, '').slice(0, 4); });
  $('#lgGo').onclick = async () => {
    const t = TECNICOS.find((x) => x.codigo === selCod);
    const cod = $('#lgCod').value.trim();
    if (!t) { $('#lgMsg').textContent = 'Elegí tu nombre de la lista primero.'; return; }
    if (cod.length !== 4) { $('#lgMsg').textContent = 'Completá los 4 dígitos.'; $('#lgCod').focus(); return; }
    $('#lgGo').disabled = true; $('#lgMsg').textContent = 'Verificando…';
    let r, d = {};
    try {
      r = await fetch(SERVER + `/login?tc=${encodeURIComponent(t.codigo)}&cod=${cod}`, { cache: 'no-store' });
      d = r.ok ? await r.json() : {};
    } catch (e) { r = null; }
    $('#lgGo').disabled = false;
    if (!r) { $('#lgMsg').textContent = 'Sin conexión con el servidor. Reintentá.'; return; }
    if (r.status === 401) { $('#lgMsg').textContent = 'Código incorrecto. Verificá tu código personal.'; $('#lgCod').focus(); return; }
    if (!r.ok) { $('#lgMsg').textContent = 'Error: ' + safeErr(JSON.stringify(d)); return; }
    abrirSesion(Object.assign({}, t, { tk: d.tk, vence: d.vence, cod: d.cod })); render();
    toast(`👋 Hola ${t.nombre.split(' ')[0]}, listo para trabajar`);
  };
  $('#lgTest').onclick = (e) => { e.preventDefault(); $('#lgTestBox').style.display = ''; };
  $('#lgTestGo').onclick = () => {
    const c = ($('#lgTestTc').value || '').trim().toUpperCase();
    if (!c) { $('#lgTestTc').focus(); return; }
    abrirSesion({ codigo: c, nombre: c + ' (prueba)', prueba: true });
    render();
  };
  if (!sugerido && TECNICOS.length) $('#lgCod').focus();
}

function render() {
  if (!SES) { renderLogin(); return; }
  const enCurso = S.activo, cerrada = !enCurso && S.fin && S.inicio;
  let chip = '<span class="chip off"><i class="fa-solid fa-moon"></i> fuera de horario</span>';
  if (enCurso) chip = '<span class="chip live pulse"><i class="fa-solid fa-bolt"></i> EN TURNO</span>';
  else if (cerrada) chip = '<span class="chip fin"><i class="fa-solid fa-circle-check"></i> jornada cerrada</span>';
  const genUrl = URL_GENERADOR + '?tec=' + encodeURIComponent(SES.codigo) +
                 (SES.cod ? '&cod=' + encodeURIComponent(SES.cod) : '');

  app.innerHTML = `
    <div class="card row spread">
      <div class="row"><div class="logo" style="width:44px;height:44px;border-radius:12px;background:var(--mostaza);
        display:grid;place-items:center;color:#111;font-weight:800;font-family:Montserrat">
        ${esc(TC.slice(0, 2))}</div>
        <div><h2 style="margin:0;font-size:17px">${esc(SES.nombre || TC)}</h2>
        <span class="mut" style="font-size:12px">${esc(S.viaje ? 'en camino a ' + S.viaje : (enCurso ? 'en ruta' : 'sin jornada'))}</span></div></div>
      ${chip}</div>
    <button class="big viaje" id="btnViaje" ${enCurso ? '' : 'disabled'}>
      <i class="fa-solid fa-van-shuttle"></i> 🚐 Voy hacia…</button>
    <button class="big start" id="btnStart" ${enCurso ? 'disabled' : ''}>
      <i class="fa-solid fa-play"></i> Iniciar jornada</button>
    ${enCurso ? `<button class="big llegar" id="btnLlegada">
      <i class="fa-solid fa-person-walking-arrow-right"></i> Llegué al local</button>` : ''}
    <button class="big gho" id="btnSoporte"><i class="fa-solid fa-headset"></i> 🖥️ Soporte remoto a un local</button>
    ${enCurso ? `<button class="big gho" id="btnAdmin"><i class="fa-solid fa-clipboard-check"></i> 📋 Trabajo administrativo</button>` : ''}
    <div class="status">
      <div class="card" style="padding:12px"><div class="n">${fmt(S.inicio)}</div><div class="l">Inicio</div></div>
      <div class="card" style="padding:12px"><div class="n">${fmt(S.fin)}</div><div class="l">Fin</div></div>
    </div>
    ${cerrada ? '<button class="big viaje" id="btnRep"><i class="fa-solid fa-clipboard-list"></i> Completar reporte de cierre</button>' : ''}
    <div class="card">
      <h3 style="margin:0 0 10px"><i class="fa-solid fa-toolbox" style="color:var(--mostaza)"></i> Herramientas</h3>
      <a class="big viaje" id="btnGen" href="${esc(genUrl)}" target="_blank" rel="noopener"
         style="text-decoration:none;margin-bottom:10px"><i class="fa-solid fa-file-pen"></i> 📝 Generador de Informes</a>
      <a class="big gho" id="btnLoc" href="${esc(URL_LOCALIZADOR)}" target="_blank" rel="noopener"
         style="text-decoration:none"><i class="fa-solid fa-magnifying-glass-location"></i> 📍 Localizador de Locales</a>
    </div>
    ${enCurso ? `<div class="slidefin" id="slideFin"><div class="slidefin-track" id="slideFinTrack">
      <div class="slidefin-fill" id="finFill"></div>
      <div class="slidefin-label" id="finLbl"><i class="fa-solid fa-stop"></i>&nbsp; Deslizá para finalizar la jornada</div>
      <div class="slidefin-handle" id="finHandle"><i class="fa-solid fa-arrow-right"></i></div>
    </div></div>` : ''}
    <div class="card note" style="margin-top:0">🔋 Mantené la app abierta en segundo plano.
    Si la cerrás, al volver sigue el registro.</div>`;

  $('#btnStart').onclick = iniciar;
  if (enCurso) {
    montarSlideFin(() => { enviarPing('auto'); cerrar(); });   // al finalizar, última posición al día
    $('#btnLlegada').onclick = () => enviarPing('llegada');
  }
  $('#btnViaje').onclick = () => { pingAuto(); abrirSelector('viaje'); };
  $('#btnSoporte').onclick = () => { pingAuto(); abrirSelector('soporte'); };
  const ba = $('#btnAdmin');
  if (ba) ba.onclick = async () => {
    pingAuto();
    const r = await api(`/admin?tc=${encodeURIComponent(TC)}`);
    if (r.ok) toast(r.text.startsWith('ya anunciado') ? '📋 Ya lo avisaste hace menos de 1 hora' : '📋 Aviso enviado al grupo');
    else toast('Error: ' + safeErr(r.text));
  };
  $('#btnGen').onclick = pingAuto;
  $('#btnLoc').onclick = pingAuto;
  const b = $('#btnRep'); if (b) b.onclick = () => { pingAuto(); $('#ovRep').classList.add('on'); };
}

// ---------- barra superior ----------
function refrescoChipRed() {
  const c = $('#netChip');
  if (navigator.onLine) c.className = 'chip', c.innerHTML = '<i class="fa-solid fa-wifi"></i> en línea';
  else c.className = 'chip off', c.innerHTML = '<i class="fa-solid fa-plane-slash"></i> sin red';
}
window.addEventListener('online', refrescoChipRed);
window.addEventListener('offline', refrescoChipRed);
refrescoChipRed();

$('#cfgBtn').onclick = () => {
  estadoInstalacion();
  $('#cfgQuien').textContent = SES ? (SES.nombre || SES.codigo) + (SES.prueba ? ' (prueba)' : '') : 'sin sesión';
  $('#cfgServer').textContent = SERVER;
  $('#ovCfg').classList.add('on');
};
$('#cfgLogout').onclick = cerrarSesion;

// ---------- cerrar modales: toque afuera del cuadro o × ----------
document.querySelectorAll('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('on'); });
});
document.querySelectorAll('.xclose').forEach((x) => {
  x.onclick = () => $('#' + x.dataset.close).classList.remove('on');
});

// ---------- instalación PWA ----------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const b = $('#instBtn'); if (b) { b.style.display = ''; b.onclick = pedirInstalacion; }
  const t = $('#cfgInst'); if (t) t.textContent = 'lista para instalar';
});
async function pedirInstalacion() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  const b = $('#instBtn'); if (b) b.style.display = 'none';
}
window.addEventListener('appinstalled', () => {
  const t = $('#cfgInst'); if (t) t.textContent = '✓ instalada';
  const b = $('#instBtn'); if (b) b.style.display = 'none';
  toast('✅ App instalada en tu celular');
});
function estadoInstalacion() {
  const t = $('#cfgInst'); if (!t) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) { t.textContent = '✓ ya instalada (se abre sola)'; return; }
  if (deferredPrompt) { t.textContent = 'lista para instalar'; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  t.textContent = ios ? 'Safari: Compartir › Agregar a Inicio'
                      : 'Menú ⋮ de Chrome › Instalar aplicación';
}
$('#salirBtn').onclick = cerrarSesion;
$('#repSend').onclick = enviarReporte;

// ---------- arranque ----------
if (TC) $('#salirBtn').style.display = '';
(async () => {
  await cargarApiBase();
  await cargarTecnicos();
  // si quedó una jornada abierta de antes, retomar el ciclo de pings
  if (S.activo && TC) { S.dueno = S.dueno || TC; pingLoop(false); }
  render();
})();
})();
