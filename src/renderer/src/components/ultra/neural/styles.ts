// The motion of the network. Everything animates transform, opacity or a dash offset, so the
// graphics card does it without React. It pauses while the window is in the background and
// stands still (with every state still readable) for anyone who asked for less motion.

const CSS = `
.nn-breathe { transform-box: fill-box; transform-origin: center; animation: nn-breathe 2.4s ease-in-out infinite; }
@keyframes nn-breathe { 0%, 100% { transform: scale(0.9); opacity: 0.78; } 50% { transform: scale(1.1); opacity: 1; } }
.nn-spin { transform-box: fill-box; transform-origin: center; animation: nn-spin 1.6s linear infinite; }
@keyframes nn-spin { to { transform: rotate(360deg); } }
.nn-flow { animation: nn-flow 2.2s linear infinite; }
@keyframes nn-flow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
.nn-out { animation: nn-out 1.1s cubic-bezier(0.45, 0, 0.25, 1) both; }
@keyframes nn-out { 0% { stroke-dashoffset: 14; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { stroke-dashoffset: -100; opacity: 0; } }
.nn-back { animation: nn-back 1.1s cubic-bezier(0.45, 0, 0.25, 1) both; }
@keyframes nn-back { 0% { stroke-dashoffset: -100; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { stroke-dashoffset: 14; opacity: 0; } }
.nn-grow { animation: nn-grow 0.9s cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes nn-grow { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
.nn-born { transform-box: fill-box; transform-origin: center; animation: nn-born 0.55s cubic-bezier(0.34, 1.5, 0.64, 1) 0.45s both; }
@keyframes nn-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes nn-born { from { transform: scale(0.1); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.nn-node { transition: transform 0.7s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s; }
.nn-link { transition: opacity 0.3s; }
.nn-link path, path.nn-link, .nn-pulse path { transition: d 0.7s cubic-bezier(0.22, 1, 0.36, 1), stroke-width 0.3s, opacity 0.3s; }
.nn-glow { transition: opacity 0.3s; }
.nn-label { transition: transform 0.7s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s; }
[data-nn-focus] .nn-node:not([data-near]) { opacity: 0.22; }
[data-nn-focus] .nn-link:not([data-near]) { opacity: 0.08; }
[data-nn-focus] .nn-label:not([data-near]) { opacity: 0.2; }
html[data-away='true'] .nn-breathe, html[data-away='true'] .nn-spin, html[data-away='true'] .nn-flow { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .nn-breathe, .nn-spin { animation: none; }
  .nn-flow, .nn-out, .nn-back { display: none; }
  .nn-grow, .nn-born { animation: none; }
  .nn-node, .nn-link, .nn-label, .nn-link path, path.nn-link, .nn-pulse path, .nn-glow { transition: none; }
}
`

if (typeof document !== 'undefined' && !document.getElementById('nn-styles')) {
  const el = document.createElement('style')
  el.id = 'nn-styles'
  el.textContent = CSS
  document.head.appendChild(el)
}

export {}
