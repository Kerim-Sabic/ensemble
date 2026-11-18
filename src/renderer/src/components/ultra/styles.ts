// The few styles the Ultra look needs, kept with it rather than in the shared stylesheet.
// Everything that moves animates transform, opacity or a dash offset, stops while the window is
// in the background, and stands still for anyone who asked the system for less motion.

const CSS = `
@keyframes ux-flow { to { stroke-dashoffset: -100; } }
.ux-flow { animation: ux-flow 1.9s linear infinite; }
@keyframes ux-breathe {
  0%, 100% { transform: scale(0.8); opacity: 0.45; }
  50% { transform: scale(1.12); opacity: 1; }
}
.ux-halo { animation: ux-breathe 2.6s ease-in-out infinite; will-change: transform, opacity; }
@keyframes ux-in {
  from { transform: scale(0.25); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.ux-in { animation: ux-in 0.55s cubic-bezier(0.34, 1.4, 0.64, 1) both; }
@keyframes ux-fade { from { opacity: 0; } }
.ux-edge { transition: d 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s; animation: ux-fade 0.6s ease-out both; }
.ux-node { transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s; }
@keyframes ux-sheen { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }
.ux-ultra-text {
  background: linear-gradient(90deg, var(--ux-1), var(--ux-2), var(--ux-3), var(--ux-1));
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: ux-sheen 6s linear infinite;
}
.ux-ultra-edge {
  background: linear-gradient(90deg, transparent, var(--ux-1) 18%, var(--ux-2) 50%, var(--ux-3) 82%, transparent);
}
.ux-ultra-glow {
  background: radial-gradient(55% 100% at 50% 0%, color-mix(in oklab, var(--ux-1) 9%, transparent), transparent 72%);
}
.ux-ultra-pill {
  background: color-mix(in oklab, var(--ux-1) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ux-1) 26%, transparent);
}
.ux-ultra-frame {
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ux-1) 22%, var(--line)), 0 0 0 0.5px transparent;
  background:
    radial-gradient(70% 140% at 0% 0%, color-mix(in oklab, var(--ux-1) 7%, transparent), transparent 60%),
    radial-gradient(60% 140% at 100% 100%, color-mix(in oklab, var(--ux-3) 6%, transparent), transparent 60%),
    var(--surface);
}
:root { --ux-1: #6d4aff; --ux-2: #2f8cf0; --ux-3: #12a58a; }
.dark { --ux-1: #a08bff; --ux-2: #5fb0ff; --ux-3: #3fd3b0; }
html[data-away='true'] .ux-flow,
html[data-away='true'] .ux-halo,
html[data-away='true'] .ux-ultra-text { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .ux-flow { display: none; }
  .ux-halo, .ux-in, .ux-edge, .ux-ultra-text { animation: none; }
  .ux-node, .ux-edge { transition: none; }
}
`

if (typeof document !== 'undefined' && !document.getElementById('ux-styles')) {
  const el = document.createElement('style')
  el.id = 'ux-styles'
  el.textContent = CSS
  document.head.appendChild(el)
}

export {}
