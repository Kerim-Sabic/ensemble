// The motion of the brain view, kept with it. Only transform, opacity and a dash offset move;
// everything stops while the window is in the background and stands still for anyone who asked
// the system for less motion, with every state still readable from shape and colour alone.

const CSS = `
.bn-lobe { transition: opacity 0.8s ease, d 0.8s cubic-bezier(0.22, 1, 0.36, 1); }
.bn-glide { transition: transform 0.85s cubic-bezier(0.22, 1, 0.36, 1); }
.bn-fade { transition: opacity 0.6s ease; }
.bn-path { transition: d 0.85s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.6s ease; }
@keyframes bn-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.bn-breathe { animation: bn-breathe 2.4s ease-in-out infinite; }
@keyframes bn-orbit { to { transform: rotate(360deg); } }
.bn-orbit { transform-box: view-box; animation: bn-orbit 2.2s linear infinite; }
@keyframes bn-ripple { from { transform: scale(1); opacity: 0.55; } to { transform: scale(2.4); opacity: 0; } }
.bn-ripple { transform-box: fill-box; transform-origin: center; animation: bn-ripple 1.6s cubic-bezier(0.22, 1, 0.36, 1) 0.1s both; }
@keyframes bn-pop { from { transform: scale(0.2); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.bn-pop { transform-box: fill-box; transform-origin: center; animation: bn-pop 0.7s cubic-bezier(0.34, 1.35, 0.64, 1) both; }
@keyframes bn-line-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.bn-line-in { animation: bn-line-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes bn-drift { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
.bn-drift { animation: bn-drift 7s linear infinite; }
html[data-away='true'] .bn-breathe, html[data-away='true'] .bn-orbit, html[data-away='true'] .bn-drift { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .bn-breathe, .bn-orbit, .bn-ripple, .bn-pop, .bn-line-in, .bn-drift { animation: none; }
  .bn-orbit { display: none; }
  .bn-glide, .bn-lobe, .bn-path, .bn-fade { transition: none; }
}
`

if (typeof document !== 'undefined' && !document.getElementById('bn-styles')) {
  const el = document.createElement('style')
  el.id = 'bn-styles'
  el.textContent = CSS
  document.head.appendChild(el)
}

export {}
