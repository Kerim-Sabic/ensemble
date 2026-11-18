// The message box's Ultra look: a slowly turning gradient edge, a soft coloured glow, a pill and a
// send button in the same colours. The colours are the ones the rest of the Ultra look uses
// (--ux-1..3), with the same values as a fallback so the box never depends on another file.
// The edge turns by rotating a finished gradient (transform only, nothing repainted per frame),
// stops while the window is in the background, and stands still for anyone who asked for less motion.

const CSS = `
.cu-card { --cu-1: var(--ux-1, #6d4aff); --cu-2: var(--ux-2, #2f8cf0); --cu-3: var(--ux-3, #12a58a); }
.dark .cu-card { --cu-1: var(--ux-1, #a08bff); --cu-2: var(--ux-2, #5fb0ff); --cu-3: var(--ux-3, #3fd3b0); }
.composer.cu-card,
.composer.cu-card:focus-within,
.composer.cu-card[data-busy='true'] {
  box-shadow:
    0 2px 6px rgba(24, 20, 12, 0.05),
    0 18px 46px -18px color-mix(in oklab, var(--cu-1) 55%, transparent),
    0 10px 34px -20px color-mix(in oklab, var(--cu-3) 50%, transparent);
}
.cu-ring {
  position: absolute;
  inset: -1.5px;
  border-radius: 23.5px;
  padding: 1.5px;
  overflow: hidden;
  pointer-events: none;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  animation: cu-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.cu-spin {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 140%;
  aspect-ratio: 1;
  translate: -50% -50%;
  background: conic-gradient(from 0deg, var(--cu-1), var(--cu-2), var(--cu-3), color-mix(in oklab, var(--cu-1) 30%, transparent) 62%, var(--cu-1) 78%, var(--cu-1));
  animation: cu-turn 7s linear infinite;
  will-change: transform;
}
@keyframes cu-turn { to { transform: rotate(360deg); } }
@keyframes cu-in { from { opacity: 0; } }
.cu-pill {
  background: linear-gradient(100deg, color-mix(in oklab, var(--cu-1) 13%, transparent), color-mix(in oklab, var(--cu-3) 11%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cu-1) 30%, transparent);
}
.cu-pill:hover {
  background: linear-gradient(100deg, color-mix(in oklab, var(--cu-1) 19%, transparent), color-mix(in oklab, var(--cu-3) 16%, transparent));
}
.cu-text {
  background: linear-gradient(90deg, var(--cu-1), var(--cu-2), var(--cu-3), var(--cu-2), var(--cu-1));
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* Text is painted each time it moves, so it moves in steps. */
  animation: cu-sheen 8s steps(48) infinite;
}
.cu-icon { color: var(--cu-1, var(--ux-1, #6d4aff)); }
@keyframes cu-sheen { from { background-position: 0% 50%; } to { background-position: 300% 50%; } }
/* The same deep colours in light and dark, so white on it always reads. */
.cu-send {
  color: #fff;
  background: linear-gradient(135deg, #6d4aff, #2f7fe6 55%, #0f9a80);
  box-shadow: 0 4px 14px -4px color-mix(in oklab, var(--cu-1) 60%, transparent);
}
html[data-away='true'] .cu-spin,
html[data-away='true'] .cu-text { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .cu-spin, .cu-text, .cu-ring { animation: none; }
}
`

if (typeof document !== 'undefined' && !document.getElementById('cu-styles')) {
  const el = document.createElement('style')
  el.id = 'cu-styles'
  el.textContent = CSS
  document.head.appendChild(el)
}

export {}
