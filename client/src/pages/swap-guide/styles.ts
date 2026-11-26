import { colors } from "./theme";

const { green, muted, border } = colors;

export const GUIDE_CSS = `
.g-code > summary::-webkit-details-marker,
.g-more > summary::-webkit-details-marker { display: none; }

.g-reveal { opacity: 0; transform: translateY(16px); transition: opacity .55s ease, transform .55s ease; }
.g-reveal.g-in { opacity: 1; transform: none; }

.g-arch { display: flex; align-items: stretch; }
.g-node { flex: 1 1 0; min-width: 0; background: #fff; border: 1px solid ${border}; border-radius: 16px; padding: 16px 12px; text-align: center; animation: g-float 4s ease-in-out infinite; }
.g-node:nth-child(3) { animation-delay: .5s; }
.g-node:nth-child(5) { animation-delay: 1s; }
.g-node:nth-child(7) { animation-delay: 1.5s; }
.g-node-icon { display: block; margin-bottom: 10px; }
.g-link { flex: 0 0 84px; position: relative; display: flex; align-items: center; }
.g-link-line { width: 100%; height: 3px; background: repeating-linear-gradient(90deg, ${green} 0 7px, transparent 7px 12px); background-size: 24px 3px; animation: g-dash-x .9s linear infinite; }
.g-link-line.g-vertical { width: 3px; height: 100%; background: repeating-linear-gradient(180deg, ${green} 0 7px, transparent 7px 12px); background-size: 3px 24px; animation-name: g-dash-y; }
.g-link-dot { position: absolute; top: 50%; left: 0; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%; background: ${green}; box-shadow: 0 0 0 5px rgba(0,200,83,.18); animation: g-travel-x 3s ease-in-out infinite; }
.g-link:nth-child(4) .g-link-dot { animation-delay: 1s; }
.g-link:nth-child(6) .g-link-dot { animation-delay: 2s; }
.g-link-label { position: absolute; top: calc(50% + 12px); left: 0; right: 0; text-align: center; font-size: 11px; line-height: 1.35; color: ${muted}; font-weight: 600; }
@media (max-width: 719px) {
  .g-arch { flex-direction: column; }
  .g-node { display: flex; align-items: center; gap: 12px; text-align: left; padding: 12px 14px; animation: none; }
  .g-node-icon { display: inline-flex; margin: 0; }
  .g-link { flex: 0 0 52px; justify-content: flex-start; padding-left: 34px; }
  .g-link-line { width: 3px; height: 100%; background: repeating-linear-gradient(180deg, ${green} 0 7px, transparent 7px 12px); background-size: 3px 24px; animation-name: g-dash-y; }
  .g-link-dot { left: 30px; top: 0; margin-top: 0; animation-name: g-travel-y; }
  .g-link-label { top: 50%; transform: translateY(-50%); left: 52px; right: auto; text-align: left; }
}

.g-seqm { opacity: 0; transform-box: fill-box; }
.g-seq-play .g-seqm { animation: g-seq-in .3s ease-out forwards; animation-delay: calc(var(--i) * 0.22s); }

.g-rail-dot { position: absolute; left: 17px; top: 22px; width: 11px; height: 11px; border-radius: 50%; background: ${green}; box-shadow: 0 0 0 5px rgba(0,200,83,.18); z-index: 2; animation: g-rail 6s ease-in-out infinite; }

.g-pulse { animation: g-pulse 1.6s ease-in-out infinite; }
.g-sweep { animation: g-sweep 7s linear infinite; }

@keyframes g-dash-x { to { background-position: 24px 0; } }
@keyframes g-dash-y { to { background-position: 0 24px; } }
@keyframes g-travel-x { 0% { left: 0; opacity: 0; } 15%, 85% { opacity: 1; } 100% { left: calc(100% - 12px); opacity: 0; } }
@keyframes g-travel-y { 0% { top: 0; opacity: 0; } 15%, 85% { opacity: 1; } 100% { top: calc(100% - 12px); opacity: 0; } }
@keyframes g-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes g-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(0,200,83,.45); } 50% { box-shadow: 0 0 0 9px rgba(0,200,83,0); } }
@keyframes g-sweep { from { left: 0; } to { left: calc(100% - 4px); } }
@keyframes g-seq-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@keyframes g-rail { 0% { top: 22px; opacity: 0; } 8%, 88% { opacity: 1; } 100% { top: calc(100% - 33px); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .g-reveal { opacity: 1; transform: none; transition: none; }
  .g-node, .g-link-line, .g-link-dot, .g-rail-dot, .g-pulse, .g-sweep { animation: none !important; }
  .g-seqm { opacity: 1 !important; animation: none !important; }
  .g-link-dot, .g-rail-dot { display: none; }
}
`;
