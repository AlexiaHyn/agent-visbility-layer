import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeSplitPane } from '../public/split-pane.js';
function setup() {
  const listeners = {}, attributes = {}, classes = new Set(); let width = 560, captured = null, observer;
  const handle = {
    addEventListener: (type, handler) => { listeners[type] = handler; },
    setAttribute: (key, value) => { attributes[key] = value; }, focus() {},
    setPointerCapture: id => { captured = id; }, hasPointerCapture: id => captured === id,
    releasePointerCapture: () => { captured = null; },
  };
  const panel = { hidden: false, style: { setProperty: (key, value) => { width = parseFloat(value); } }, getBoundingClientRect: () => ({ right: 1270, width }) };
  const chat = { getBoundingClientRect: () => ({ left: 270 }) };
  const document = { querySelector: selector => ({ '#project-map-resizer': handle, '#project-map-panel': panel, '#chat-main': chat })[selector], body: { classList: { add: item => classes.add(item), remove: item => classes.delete(item) } } };
  const window = { innerWidth: 1270, addEventListener: (type, handler) => { listeners[`window:${type}`] = handler; } };
  initializeSplitPane({ document, window, ResizeObserver: class { constructor(callback) { observer = callback; } observe() {} } });
  const event = (type, data = {}) => listeners[type]({ button: 0, pointerId: 1, clientX: 670, preventDefault() {}, ...data });
  return { event, panel, window, attributes, classes, width: () => width, resized: () => observer() };
}
test('drag resizes both panes, clamps usable widths and releases pointer capture', () => {
  const ui = setup(); assert.equal(ui.width(), 600);
  ui.event('pointerdown'); assert.ok(ui.classes.has('resizing-project-map'));
  ui.event('pointermove', { clientX: 770 }); assert.equal(ui.width(), 500); assert.equal(ui.attributes['aria-valuenow'], '50');
  ui.event('pointermove', { clientX: 2000 }); assert.equal(ui.width(), 320);
  ui.event('pointermove', { clientX: -500 }); assert.equal(ui.width(), 680);
  ui.event('pointercancel'); assert.equal(ui.classes.size, 0);
  ui.event('pointermove', { clientX: 0 }); assert.equal(ui.width(), 680);
});
test('keyboard resizing survives closing the map and disables itself for mobile overlay', () => {
  const ui = setup();
  ui.event('keydown', { key: 'ArrowRight' }); assert.equal(ui.width(), 568);
  ui.panel.hidden = true; ui.resized(); ui.panel.hidden = false; ui.resized(); assert.equal(ui.width(), 568);
  ui.event('keydown', { key: 'Home' }); assert.equal(ui.width(), 680);
  ui.event('keydown', { key: 'End' }); assert.equal(ui.width(), 320);
  ui.event('pointerdown'); ui.window.innerWidth = 800; ui.resized(); assert.equal(ui.classes.size, 0);
  ui.event('keydown', { key: 'ArrowLeft' }); assert.equal(ui.width(), 320);
});
