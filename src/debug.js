// Debug overlay: a fixed-position text panel that reports live state so we can
// directly observe (in-headset or on desktop) whether sessions, controllers,
// and hands are actually tracking. Errors thrown inside the rAF loop are
// otherwise swallowed and silently kill the loop.

const debugEl = document.createElement('div');
debugEl.id = 'debug-overlay';
debugEl.style.cssText =
  'position:fixed;left:8px;top:8px;z-index:20;padding:8px 10px;' +
  'background:rgba(0,0,0,0.6);color:#7fffd0;font:12px/1.4 monospace;' +
  'white-space:pre;pointer-events:none;max-width:60vw;max-height:90vh;overflow:hidden;';
document.body.appendChild(debugEl);

export function setDebugText(text) {
  debugEl.textContent = text;
}

export function installGlobalErrorHandlers() {
  window.addEventListener('error', (e) => {
    console.error('[window.onerror]', e.message, e.error);
    setDebugText('ERROR: ' + (e.message || 'unknown'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    console.error('[unhandledrejection]', reason, e.reason);
    setDebugText('REJECT: ' + reason);
  });
}
