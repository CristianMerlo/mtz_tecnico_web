/* Chat del grupo en vivo — terminal integrado (Fase 2, RondaTracker).
   Componente aparte: se inyecta con una linea en index.html y NO toca app.js.
   Autorizacion: la sesion ya existente del tecnico (localStorage mtz_sesion:
   codigo + brazalete tk). Sin clave manual: con la app iniciada, el chat se ve.
   Consumo: 1 fetch cada 12 s al server (que lee un buffer en memoria del
   userbot); pausa automatica con la app en segundo plano o colapsada.
   Los adjuntos solo se anuncian (📎): para verlos, Telegram. */
(() => {
'use strict';
const POLL_MS = 12000, MAX_LINES = 120;
// Color fijo por tecnico (estable y reconocible); desconocidos caen en paleta por hash
const COLORES_TECS = { CRISTIAN:'#FACC15', FERNANDO:'#60A5FA', TOMAS:'#4ADE80', ANABELLA:'#F472B6',
                       FRANCISCO:'#C084FC', HERMES:'#2DD4BF' };
const COLORS = ['#f87171','#60a5fa','#4ade80','#facc15','#c084fc','#2dd4bf','#f472b6','#a3a3a3'];
function colorFor(n){
  const k = String(n||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  for (const t in COLORES_TECS) if (k.startsWith(t)) return COLORES_TECS[t];
  let h = 0; for (const c of k) h = (h*31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length];
}
// Los avisos automaticos del Supervisor (fichajes, reportes procesados) llenan el
// grupo y tapan lo escrito por personas: se ATENUA, nunca se oculta (decision de
// Cristian 20/10: la informacion sigue visible, lo humano destaca).
const AVISO_RE = /^(\[Avisos\]|\s*)(📢|✅|⚠️|🔔|🤖|ℹ️)/;
function esAviso(m){
  const n = String(m.sender_name||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (n.startsWith('SUPERVISOR') || n.startsWith('BOT')) return true;
  return AVISO_RE.test(String(m.text||'').trim());
}

// contenedor: entre el cuerpo de la app y el footer
const box = document.createElement('div');
box.style.cssText = 'margin:0 18px 14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radio);overflow:hidden;box-shadow:var(--sombra)';
box.innerHTML = `
  <div id="ctBar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--panel2);cursor:pointer">
    <span id="ctDot" style="width:8px;height:8px;border-radius:50%;background:#5b6068;flex:none"></span>
    <b style="font-family:'Montserrat';font-size:12px;letter-spacing:.4px;color:var(--mut)">CHAT DEL GRUPO · en vivo</b>
    <span id="ctAge" class="mut" style="font-size:11px;margin-left:auto"></span>
    <span id="ctToggle" style="font-size:12px;color:var(--mut)">▾</span>
  </div>
  <div id="ctLog" style="height:170px;overflow-y:auto;padding:8px 12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;color:#d4d4d8;background:#0f1013"></div>`;
const appRoot = document.querySelector('.app');
appRoot.insertBefore(box, appRoot.querySelector('footer'));
const log = box.querySelector('#ctLog'), dot = box.querySelector('#ctDot'),
      age = box.querySelector('#ctAge');
let closed = localStorage.getItem('mtz_chat_closed') === '1';
let ultimoId = 0, lastOk = null, timer = null, SERVER = location.origin;

// misma resolucion de origen que app.js: api_base.json junto al index (Pages);
// servido por el propio 8091, location.origin ya alcanza
(async () => { try {
  const r = await fetch('api_base.json', { cache: 'no-store' });
  const d = await r.json();
  if (d && typeof d.api === 'string') SERVER = d.api.replace(/\/+$/, '');
} catch (e) {} })();

function sesion(){ try { return JSON.parse(localStorage.getItem('mtz_sesion') || 'null'); } catch (e) { return null; } }

function setOpen(on){
  closed = !on;
  localStorage.setItem('mtz_chat_closed', closed ? '1' : '0');
  log.style.display = closed ? 'none' : '';
  box.querySelector('#ctToggle').textContent = closed ? '▸' : '▾';
  if (!closed && !timer) tick(), (timer = setInterval(tick, POLL_MS));
  if (closed && timer) { clearInterval(timer); timer = null; }
}
box.querySelector('#ctBar').onclick = () => setOpen(closed);
// ahorro de bateria/datos: en segundo plano no se consulta; al volver, refresco
document.addEventListener('visibilitychange', () => {
  if (document.hidden && timer) { clearInterval(timer); timer = null; }
  else if (!document.hidden && !closed && !timer) { tick(); timer = setInterval(tick, POLL_MS); }
});
// recien logueado en otra pestana: muestra el chat sin esperar el proximo tick
window.addEventListener('storage', (e) => { if (e.key === 'mtz_sesion') { ultimoId = 0; log.innerHTML = ''; tick(); } });

function linea(m){
  const d = document.createElement('div');
  const aviso = esAviso(m);
  const hhmm = m.ts ? m.ts.slice(11, 16) : '--:--';
  const who = document.createElement('span');
  who.style.color = aviso ? '#6b7280' : colorFor(m.sender_name);
  who.style.fontWeight = aviso ? '400' : '700';
  who.textContent = (m.sender_name || '?').toUpperCase().slice(0, 10).padEnd(10, ' ');
  const ts = document.createElement('span');
  ts.style.color = '#5b6068'; ts.textContent = hhmm + ' · ';
  const tx = document.createElement('span');
  if (m.text) { tx.textContent = m.text.replace(/\s+/g, ' ').slice(0, 200); }
  else { tx.style.color = '#5b6068'; tx.style.fontStyle = 'italic'; tx.textContent = '📎 adjunto (ver en Telegram)'; }
  d.append(ts, who, tx);
  if (aviso) { d.style.opacity = '0.5'; if (tx.style.color !== '#5b6068') tx.style.color = '#9ca3af'; }
  log.appendChild(d);
  while (log.children.length > MAX_LINES) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

async function tick(){
  const s = sesion();
  if (!s || !s.codigo) { dot.style.background = '#5b6068'; age.textContent = 'sin sesión'; return; }
  const url = SERVER + '/chat_live?tc=' + encodeURIComponent(s.codigo) +
              '&tk=' + encodeURIComponent(s.tk || '') +
              (ultimoId ? '&desde=' + ultimoId : '');  // incremental: solo lo nuevo (P0-C5)
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 401) { dot.style.background = '#5b6068'; age.textContent = 'sesión vencida'; return; }
    if (!r.ok) { dot.style.background = '#e85d5b'; age.textContent = 'visor no disponible'; return; }
    const data = await r.json();
    if (data.ok && Array.isArray(data.msgs)) {
      if (ultimoId === 0 && log.children.length === 0) data.msgs.forEach(linea);
      else for (const m of data.msgs) if (m.id != null && m.id > ultimoId) linea(m);
      if (data.msgs.length) ultimoId = Math.max(ultimoId, data.msgs[data.msgs.length-1].id || 0);
      dot.style.background = '#22C55E'; lastOk = Date.now(); age.textContent = 'al día';
    }
  } catch (e) { dot.style.background = '#e85d5b'; age.textContent = 'sin conexión'; }
}

setOpen(!closed);
})();
