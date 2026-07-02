/**
 * A small selection of birds found at Solio / the Greater Laikipia region.
 *
 * For the PoC each species carries colours (to draw a stylised field-guide
 * plate), a short description, and a synthesised call motif (see
 * `lib/birdsong.ts`). In production these become real photographs and audio
 * recordings, and the identifier becomes a real on-device model.
 */

import type { Note } from "../lib/birdsong";

export interface Bird {
  id: string;
  name: string;
  latin: string;
  blurb: string;
  /** Plumage colours for the stylised plate. */
  primary: string;
  secondary: string;
  beak: string;
  /** Synthesised call. */
  song: Note[];
}

export const BIRDS: Bird[] = [
  {
    id: "crowned-crane",
    name: "Grey Crowned Crane",
    latin: "Balearica regulorum",
    blurb: "Stately wetland crane with a golden crown; often in pairs on the plains.",
    primary: "#9aa0a6",
    secondary: "#e2b13c",
    beak: "#3a3a3a",
    song: [
      { f: 300, d: 0.45, type: "sawtooth", gap: 0.08 },
      { f: 360, d: 0.5, type: "sawtooth", gap: 0.18 },
      { f: 300, d: 0.5, type: "sawtooth" },
    ],
  },
  {
    id: "lilac-roller",
    name: "Lilac-breasted Roller",
    latin: "Coracias caudatus",
    blurb: "Kenya's dazzling roller — turquoise wings and a lilac breast.",
    primary: "#4f9fd6",
    secondary: "#b48ad6",
    beak: "#2a2a2a",
    song: [
      { f: 720, d: 0.07, type: "sawtooth" },
      { f: 600, d: 0.07, type: "sawtooth" },
      { f: 760, d: 0.07, type: "sawtooth" },
      { f: 580, d: 0.09, type: "sawtooth", gap: 0.12 },
      { f: 700, d: 0.07, type: "sawtooth" },
      { f: 560, d: 0.1, type: "sawtooth" },
    ],
  },
  {
    id: "superb-starling",
    name: "Superb Starling",
    latin: "Lamprotornis superbus",
    blurb: "Iridescent blue with a chestnut belly; bold around camps and lodges.",
    primary: "#2a7fb8",
    secondary: "#c0622d",
    beak: "#1c1c1c",
    song: [
      { f: 1300, d: 0.06 },
      { f: 1700, d: 0.06 },
      { f: 1100, d: 0.06 },
      { f: 1500, d: 0.06 },
      { f: 1800, d: 0.06 },
      { f: 1200, d: 0.06 },
      { f: 1600, d: 0.08 },
    ],
  },
  {
    id: "fish-eagle",
    name: "African Fish Eagle",
    latin: "Haliaeetus vocifer",
    blurb: "The iconic voice of African waterways — a ringing, far-carrying cry.",
    primary: "#5a4632",
    secondary: "#f1ece1",
    beak: "#e2b13c",
    song: [
      { f: 1900, f2: 1500, d: 0.28, gap: 0.06 },
      { f: 1600, f2: 1150, d: 0.3, gap: 0.12 },
      { f: 1800, f2: 1300, d: 0.26, gap: 0.06 },
      { f: 1500, f2: 1050, d: 0.32 },
    ],
  },
  {
    id: "hadada-ibis",
    name: "Hadada Ibis",
    latin: "Bostrychia hagedash",
    blurb: "Famous for its loud, laughing 'haa-haa-haa' at dawn and dusk.",
    primary: "#6e7468",
    secondary: "#8a8f7e",
    beak: "#2a2a2a",
    song: [
      { f: 500, d: 0.22, type: "square", gap: 0.06 },
      { f: 660, d: 0.26, type: "square", gap: 0.06 },
      { f: 480, d: 0.3, type: "square" },
    ],
  },
  {
    id: "augur-buzzard",
    name: "Augur Buzzard",
    latin: "Buteo augur",
    blurb: "A highland raptor of the Aberdare foothills; rufous tail, harsh call.",
    primary: "#4a4a4a",
    secondary: "#b0392a",
    beak: "#e2b13c",
    song: [
      { f: 1500, f2: 850, d: 0.35, type: "sawtooth", gap: 0.12 },
      { f: 1400, f2: 800, d: 0.38, type: "sawtooth" },
    ],
  },
  {
    id: "guineafowl",
    name: "Helmeted Guineafowl",
    latin: "Numida meleagris",
    blurb: "Spotted ground bird in noisy flocks; a rattling, mechanical cackle.",
    primary: "#48555f",
    secondary: "#cfd3d6",
    beak: "#b0392a",
    song: [
      { f: 820, d: 0.05, type: "square", gap: 0.02 },
      { f: 760, d: 0.05, type: "square", gap: 0.02 },
      { f: 840, d: 0.05, type: "square", gap: 0.02 },
      { f: 760, d: 0.05, type: "square", gap: 0.02 },
      { f: 860, d: 0.05, type: "square", gap: 0.02 },
      { f: 780, d: 0.05, type: "square", gap: 0.02 },
      { f: 840, d: 0.05, type: "square" },
    ],
  },
  {
    id: "red-billed-hornbill",
    name: "Red-billed Hornbill",
    latin: "Tockus erythrorhynchus",
    blurb: "Comical long red bill; a steady clucking that builds through the morning.",
    primary: "#e8e2d2",
    secondary: "#7b7264",
    beak: "#b0392a",
    song: [
      { f: 360, d: 0.09, type: "square", gap: 0.07 },
      { f: 360, d: 0.09, type: "square", gap: 0.07 },
      { f: 380, d: 0.09, type: "square", gap: 0.06 },
      { f: 360, d: 0.09, type: "square", gap: 0.05 },
      { f: 380, d: 0.09, type: "square", gap: 0.04 },
      { f: 360, d: 0.1, type: "square" },
    ],
  },
];
