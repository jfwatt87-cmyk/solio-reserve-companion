/**
 * Per-species field-guide illustrations. Each bird gets a hand-built, stylised
 * vector portrait keyed by id — recognisable silhouette, signature feature and
 * true-to-life palette — rather than one generic tinted shape. In production
 * these become real photographs; the layout around them is unchanged.
 */

import type { Bird } from "../data/birds";

export function BirdArt({ bird, size = 64 }: { bird: Bird; size?: number }) {
  return (
    <div className="bird-plate">
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
        <defs>
          <clipPath id="plateClip"><rect x="0" y="0" width="64" height="64" rx="0" /></clipPath>
        </defs>
        <g clipPath="url(#plateClip)">
          {/* shared backdrop: soft sky over a savanna band */}
          <rect x="0" y="0" width="64" height="64" fill="#cfe2e8" />
          <ellipse cx="20" cy="10" rx="9" ry="9" fill="#eaf3f4" opacity="0.6" />
          <rect x="0" y="44" width="64" height="20" fill="#d9c98a" />
          <rect x="0" y="44" width="64" height="3.5" fill="#c9b673" opacity="0.7" />
          {ART[bird.id]?.(bird) ?? generic(bird)}
        </g>
      </svg>
    </div>
  );
}

type Draw = (b: Bird) => JSX.Element;

const perch = (
  <line x1="6" y1="52" x2="58" y2="50" stroke="#6b5436" strokeWidth="3" strokeLinecap="round" />
);
const legs = (x1: number, x2: number, top: number, bottom = 51) => (
  <>
    <line x1={x1} y1={top} x2={x1} y2={bottom} stroke="#3a3a3a" strokeWidth="1.6" strokeLinecap="round" />
    <line x1={x2} y1={top} x2={x2} y2={bottom} stroke="#3a3a3a" strokeWidth="1.6" strokeLinecap="round" />
  </>
);
const eye = (cx: number, cy: number) => <circle cx={cx} cy={cy} r="1.3" fill="#15110b" />;

const ART: Record<string, Draw> = {
  // Grey Crowned Crane — tall, golden spiky crown, red throat, white cheek.
  "crowned-crane": () => (
    <g>
      {legs(28, 34, 40, 56)}
      <ellipse cx="30" cy="36" rx="13" ry="8" fill="#9aa0a6" />
      <path d="M40,34 Q47,30 49,22" stroke="#9aa0a6" strokeWidth="5" fill="none" strokeLinecap="round" />
      <ellipse cx="49" cy="18" rx="5" ry="5.5" fill="#1d1d1d" />
      <path d="M52,17 L60,17.5 L52,19.5 Z" fill="#cfcfcf" />
      {/* golden crown spikes */}
      {[-7, -3.5, 0, 3.5, 7].map((dx, i) => (
        <line key={i} x1={49 + dx * 0.5} y1="13.5" x2={49 + dx} y2="6" stroke="#e2b13c" strokeWidth="1.4" strokeLinecap="round" />
      ))}
      <circle cx="49" cy="13.5" r="2.4" fill="#e2b13c" />
      <ellipse cx="47" cy="18.5" rx="2.2" ry="2.8" fill="#f2efe9" />
      <circle cx="49.5" cy="21.5" r="1.6" fill="#b0392a" />
      {eye(49.5, 17)}
      <path d="M18,33 Q22,40 17,45 L24,40 Z" fill="#7e848a" />
    </g>
  ),

  // Lilac-breasted Roller — turquoise wings, lilac breast, tail streamers.
  "lilac-roller": (b) => (
    <g>
      {perch}
      {legs(30, 35, 44)}
      <path d="M33,46 L40,60 M36,46 L44,59" stroke="#2f6fb0" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="30" cy="38" rx="9" ry="11" fill={b.secondary} />
      <path d="M28,30 Q40,30 42,46 Q33,44 26,40 Z" fill={b.primary} />
      <path d="M30,40 Q41,42 47,52 Q36,50 28,46 Z" fill="#2f6fb0" />
      <circle cx="29" cy="24" r="6.5" fill="#7fae5a" />
      <path d="M23,23 L14,24.5 L23,26.5 Z" fill={b.beak} />
      {eye(27, 23)}
    </g>
  ),

  // Superb Starling — glossy blue back, chestnut belly, white breast-band.
  "superb-starling": (b) => (
    <g>
      {perch}
      {legs(30, 35, 43)}
      <path d="M34,44 L40,56 M37,44 L45,55" stroke="#1c1c1c" strokeWidth="1.8" strokeLinecap="round" />
      <ellipse cx="31" cy="36" rx="10" ry="9" fill={b.secondary} />
      <path d="M22,32 Q34,26 42,40 Q31,40 24,40 Z" fill={b.primary} />
      <rect x="23" y="34" width="16" height="2.6" rx="1.3" fill="#f2efe9" />
      <circle cx="27" cy="25" r="6.5" fill={b.primary} />
      <path d="M21,24 L13,25.5 L21,27 Z" fill={b.beak} />
      <circle cx="26" cy="24" r="1.7" fill="#f2efe9" />
      <circle cx="26" cy="24" r="0.8" fill="#15110b" />
    </g>
  ),

  // African Fish Eagle — white head & chest, dark body, yellow hooked bill.
  "fish-eagle": (b) => (
    <g>
      {perch}
      {legs(30, 36, 42)}
      <path d="M31,43 L31,53 M37,43 L37,52" stroke="#e2b13c" strokeWidth="2.2" strokeLinecap="round" />
      <ellipse cx="33" cy="36" rx="11" ry="10" fill={b.primary} />
      <path d="M24,28 Q34,24 40,30 Q40,38 30,40 Q24,36 24,28 Z" fill={b.secondary} />
      <circle cx="27" cy="24" r="7" fill={b.secondary} />
      <path d="M21,22 Q12,21 14,27 Q19,26 22,26 Z" fill={b.beak} />
      <path d="M16,22 Q12,22 13.5,25" stroke="#2a2a2a" strokeWidth="0.8" fill="none" />
      {eye(26, 23)}
    </g>
  ),

  // Hadada Ibis — grey body, long down-curved bill, iridescent wing flash.
  "hadada-ibis": (b) => (
    <g>
      {legs(28, 35, 41, 56)}
      <ellipse cx="30" cy="35" rx="13" ry="8" fill={b.primary} />
      <ellipse cx="34" cy="33" rx="6" ry="4" fill="#5f7d6e" opacity="0.8" />
      <path d="M41,32 Q46,28 48,22" stroke={b.secondary} strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="48" cy="21" r="4.5" fill={b.secondary} />
      <path d="M50,20 Q60,24 62,33" stroke={b.beak} strokeWidth="2" fill="none" strokeLinecap="round" />
      {eye(49, 20)}
      <path d="M18,33 Q22,39 17,43 L24,39 Z" fill="#5f6459" />
    </g>
  ),

  // Augur Buzzard — dark above, white below, rufous tail, hooked bill.
  "augur-buzzard": (b) => (
    <g>
      {perch}
      <path d="M28,44 L26,56 M40,44 L44,55" stroke={b.secondary} strokeWidth="3" strokeLinecap="round" />
      <path d="M22,30 Q33,22 44,30 Q44,44 33,46 Q22,44 22,30 Z" fill={b.primary} />
      <path d="M26,38 Q33,36 40,38 Q33,46 26,38 Z" fill="#eceae3" />
      <circle cx="28" cy="26" r="6.5" fill={b.primary} />
      <path d="M22,25 Q15,23 17,28 Q20,27 23,27 Z" fill={b.beak} />
      <path d="M19,25 Q15,25 16,28" stroke="#2a2a2a" strokeWidth="0.8" fill="none" />
      {eye(27, 25)}
      <circle cx="33" cy="36" r="0.9" fill="#4a4a4a" />
      <circle cx="30" cy="40" r="0.9" fill="#4a4a4a" />
      <circle cx="36" cy="40" r="0.9" fill="#4a4a4a" />
    </g>
  ),

  // Helmeted Guineafowl — spotted slate body, bare blue head, red casque.
  "guineafowl": (b) => (
    <g>
      {legs(28, 36, 46, 56)}
      <ellipse cx="31" cy="38" rx="14" ry="11" fill={b.primary} />
      {/* white spots */}
      {[[24, 34], [30, 32], [37, 35], [42, 39], [27, 42], [34, 43], [40, 44], [21, 40], [31, 38]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.5" fill={b.secondary} />
      ))}
      <path d="M40,30 Q47,28 46,22" stroke="#8fa3ad" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="46" cy="20" r="4.5" fill="#9fb7c2" />
      <path d="M46,16 Q49,11 47,8 Q44,11 45,16 Z" fill={b.beak} />
      <path d="M50,21 L54,22 L50,23.5 Z" fill="#d8b24a" />
      <path d="M44,24 Q41,27 44,28" fill="#b0392a" />
      {eye(45, 20)}
    </g>
  ),

  // Red-billed Hornbill — pale body, big down-curved red bill, long tail.
  "red-billed-hornbill": (b) => (
    <g>
      {perch}
      {legs(28, 34, 44)}
      <path d="M30,45 L34,60 M33,45 L40,58" stroke="#7b7264" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="29" cy="37" rx="9" ry="9" fill={b.primary} />
      <path d="M22,30 Q31,27 36,36 Q29,38 23,38 Z" fill={b.secondary} />
      <circle cx="26" cy="26" r="6.5" fill={b.primary} />
      {/* big curved bill */}
      <path d="M21,25 Q9,24 11,33 Q17,30 22,28 Z" fill={b.beak} />
      <path d="M21,26 Q13,26 13,30" stroke="#7a241a" strokeWidth="0.8" fill="none" />
      <circle cx="25" cy="24.5" r="1.6" fill="#f2efe9" />
      <circle cx="25" cy="24.5" r="0.8" fill="#15110b" />
    </g>
  ),
};

/** Fallback for any species without a bespoke portrait. */
function generic(b: Bird): JSX.Element {
  return (
    <g>
      {perch}
      {legs(28, 34, 44)}
      <ellipse cx="30" cy="38" rx="11" ry="9" fill={b.primary} />
      <path d="M21,33 Q32,38 39,47 Q28,46 19,42 Z" fill={b.secondary} />
      <circle cx="40" cy="30" r="7" fill={b.primary} />
      <path d="M47,28.5 L59,31 L47,33.5 Z" fill={b.beak} />
      {eye(42, 29)}
    </g>
  );
}
