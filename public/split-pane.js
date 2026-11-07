// Keep the chosen split while the map is closed; mobile keeps its full-screen map.
export function initializeSplitPane({ document, window, ResizeObserver = window.ResizeObserver }) {
  const handle = document.querySelector('#project-map-resizer');
  const panel = document.querySelector('#project-map-panel');
  const chat = document.querySelector('#chat-main');
  let ratio = 0.6;
  let drag = null;
  const desktop = () => window.innerWidth > 1000 && !panel.hidden;
  const available = () => panel.getBoundingClientRect().right - chat.getBoundingClientRect().left;
  function apply(width, total = available()) {
    if (!desktop() || total <= 0) return;
    const minimum = Math.min(320, total / 2);
    const next = Math.max(minimum, Math.min(total - minimum, width));
    panel.style.setProperty('--project-map-width', `${next}px`);
    const chatPercent = Math.round((total - next) / total * 100);
    handle.setAttribute('aria-valuemin', String(Math.round(minimum / total * 100)));
    handle.setAttribute('aria-valuemax', String(Math.round((total - minimum) / total * 100)));
    handle.setAttribute('aria-valuenow', String(chatPercent));
    handle.setAttribute('aria-valuetext', `Chat ${chatPercent}%, project map ${100 - chatPercent}%`);
    return next;
  }
  function stop() {
    if (!drag) return;
    const pointerId = drag.id; drag = null;
    document.body.classList.remove('resizing-project-map');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !desktop()) return;
    event.preventDefault(); handle.focus();
    drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-project-map');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const total = available();
    const width = apply(drag.width + drag.x - event.clientX, total);
    if (width !== undefined) ratio = width / total;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, event => {
    if (event.pointerId === drag?.id) stop();
  });
  handle.addEventListener('keydown', event => {
    if (!desktop() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const total = available(), current = panel.getBoundingClientRect().width;
    const width = apply(event.key === 'Home' ? total : event.key === 'End' ? 0 : current + (event.key === 'ArrowLeft' ? 32 : -32), total);
    if (width !== undefined) ratio = width / total;
  });
  function resize() {
    if (!desktop()) { stop(); return; }
    const total = available(); apply(total * ratio, total);
  }
  window.addEventListener('resize', resize);
  if (ResizeObserver) {
    const observer = new ResizeObserver(resize);
    observer.observe(chat); observer.observe(panel);
  }
  resize();
}
