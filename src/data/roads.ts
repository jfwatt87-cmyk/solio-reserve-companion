/**
 * The reserve road network, digitized from the drawn roads on the georeferenced
 * poster and lifted to real-world coordinates via the georeference.
 *
 * Every `via` polyline was traced along a drawn road centreline on the native
 * 4202×6774 poster, then back-projected (native px → EPSG:3857 → WGS84 → authored
 * 2400×3601 px) — the same inverse georeference used to place the POIs — so the
 * routes follow the artwork AND are GPS-accurate. Wide rivers are crossed only
 * where the poster draws a bridge (Middle Bridge et al.); narrow streams only at
 * drawn drifts. Each edge carries a surface class — graded all-weather road, dirt
 * game-drive track, or rough 4x4-only track. Node ids double as routing waypoints;
 * named edges drive turn-by-turn directions.
 *
 * When Solio’s real GIS road vectors arrive, run tools/roads/import_gis_roads.py
 * to generate roads.gis.ts, which supersedes this traced network (see data/roadSource.ts).
 */

import { pixelWorld } from "./reserve";
import { RoadNetwork, type RoadClass, type RoadEdge, type RouteNode } from "../lib/routing";
import type { Pixel } from "../lib/georef";

interface RawNode {
  id: string;
  pixel: Pixel;
}

// Nodes at the real POIs plus the junctions where the drawn roads meet
// (base-image pixels). POI pixels are the verified ones; junction pixels sit on
// drawn road junctions located during tracing.
const RAW_NODES: RawNode[] = [
  { id: "gate", pixel: { x: 601, y: 2671 } },
  { id: "airstrip", pixel: { x: 485, y: 2666 } },
  { id: "lodge", pixel: { x: 869, y: 2406 } },
  { id: "orphanage", pixel: { x: 759, y: 2514 } },
  { id: "jw", pixel: { x: 778, y: 1900 } },
  { id: "kingfisher", pixel: { x: 952, y: 1055 } },
  { id: "yellowthorn", pixel: { x: 1594, y: 1237 } },
  { id: "naribo", pixel: { x: 1814, y: 1013 } },
  { id: "choroa", pixel: { x: 1601, y: 1610 } },
  { id: "rhinogate", pixel: { x: 2044, y: 906 } },
  { id: "j1", pixel: { x: 746, y: 2423 } },
  { id: "j2", pixel: { x: 1068, y: 2021 } },
  { id: "j3", pixel: { x: 1373, y: 1463 } },
  { id: "j4", pixel: { x: 1516, y: 1154 } },
  { id: "j5", pixel: { x: 1850, y: 1237 } },
  // Junctions added when the network was properly NODED: every drawn
  // intersection the routes rely on is a shared node, so A* can turn there
  // instead of doubling back along a corridor traced twice.
  //   j6 — River Drive / j2-branch fork (north of the lodge)
  //   j7 — lodge & j1 tracks meet River Drive
  //   j8 — Kongoni Plain crossroads (Eastern Circuit / Naribo Track)
  //   j9 — Naribo Track / Rhino Gate Road fork at the river
  //   j10 — Acacia Loop / Northern Link (j4 spur) junction
  //   j11 — Acacia Loop / Western Track fork at the drift
  //   j12 — Lodge Lane / Mara Plain Track fork; the lodge hangs on a spur
  //   j13 — Gate Road / Lodge Lane fork; the orphanage hangs on a spur
  //   j14 — River Drive corner where the Riverbank Track heads east; jw spur
  //   j15 — Riverbank Track joins the Acacia Loop corridor
  //   j16 — Acacia Loop / Bush Track (choroa) fork
  { id: "j6", pixel: { x: 909, y: 2258 } },
  { id: "j7", pixel: { x: 827, y: 2384 } },
  { id: "j8", pixel: { x: 1556, y: 1087 } },
  { id: "j9", pixel: { x: 1730, y: 991 } },
  { id: "j10", pixel: { x: 1496, y: 1174 } },
  { id: "j11", pixel: { x: 1401, y: 1286 } },
  { id: "j12", pixel: { x: 853, y: 2385 } },
  { id: "j13", pixel: { x: 778, y: 2529 } },
  { id: "j14", pixel: { x: 881, y: 1903 } },
  { id: "j15", pixel: { x: 1081, y: 1862 } },
  { id: "j16", pixel: { x: 1331, y: 1623 } },
];

interface RawEdge {
  a: string;
  b: string;
  name: string;
  type: RoadClass;
  via?: Pixel[];
  /** Marks a river-crossing (bridge/drift) for a crossing symbol. */
  crossing?: boolean;
}

// Traced centrelines. Vertices are authored pixels (~26 px apart, denser on
// bends); pixelWorld() lifts them to GPS when the graph is built.
const RAW_EDGES: RawEdge[] = [
  // The airstrip symbol sits just outside the gate; a short graded spur (not a
  // drawn road on the poster).
  { a: "gate", b: "airstrip", name: "Airstrip Road", type: "graded" },
  {
    a: "gate",
    b: "j13",
    name: "Gate Road",
    type: "graded",
    via: [{ x: 588, y: 2674 }, { x: 592, y: 2673 }, { x: 609, y: 2668 }, { x: 619, y: 2660 }, { x: 629, y: 2662 }, { x: 645, y: 2656 }, { x: 658, y: 2644 }, { x: 670, y: 2644 }, { x: 675, y: 2640 }, { x: 686, y: 2640 }, { x: 693, y: 2632 }, { x: 701, y: 2632 }, { x: 708, y: 2636 }, { x: 714, y: 2636 }, { x: 717, y: 2633 }, { x: 721, y: 2620 }, { x: 726, y: 2613 }, { x: 732, y: 2609 }, { x: 741, y: 2608 }, { x: 747, y: 2605 }, { x: 748, y: 2600 }, { x: 745, y: 2594 }, { x: 747, y: 2583 }, { x: 751, y: 2579 }, { x: 764, y: 2574 }, { x: 768, y: 2571 }, { x: 771, y: 2552 }, { x: 780, y: 2542 }],
  },
  // The orphanage sits on a short spur off the j13 fork by Waterbuck Bridge,
  // where the Gate Road meets Lodge Lane.
  { a: "j13", b: "orphanage", name: "Gate Road", type: "graded" },
  {
    a: "j13",
    b: "j12",
    name: "Lodge Lane",
    type: "graded",
    via: [{ x: 787, y: 2521 }, { x: 796, y: 2514 }, { x: 793, y: 2508 }, { x: 793, y: 2504 }, { x: 804, y: 2492 }, { x: 812, y: 2486 }, { x: 823, y: 2474 }, { x: 833, y: 2462 }, { x: 843, y: 2450 }, { x: 842, y: 2441 }, { x: 845, y: 2425 }, { x: 839, y: 2404 }, { x: 843, y: 2390 }],
  },
  // The lodge sits on a short spur off the j12 fork where Lodge Lane meets the
  // Mara Plain Track, so through-routes past the lodge never double the spur.
  { a: "j12", b: "lodge", name: "Lodge Lane", type: "graded" },
  {
    a: "gate",
    b: "j1",
    name: "Zebra Plain Track",
    type: "dirt",
    via: [{ x: 588, y: 2674 }, { x: 592, y: 2673 }, { x: 609, y: 2668 }, { x: 619, y: 2660 }, { x: 619, y: 2658 }, { x: 615, y: 2653 }, { x: 612, y: 2640 }, { x: 613, y: 2621 }, { x: 611, y: 2604 }, { x: 609, y: 2588 }, { x: 610, y: 2566 }, { x: 612, y: 2545 }, { x: 619, y: 2524 }, { x: 626, y: 2503 }, { x: 634, y: 2483 }, { x: 645, y: 2477 }, { x: 657, y: 2472 }, { x: 675, y: 2466 }, { x: 694, y: 2460 }, { x: 705, y: 2452 }, { x: 713, y: 2449 }, { x: 726, y: 2440 }, { x: 739, y: 2430 }],
  },
  {
    a: "j1",
    b: "j7",
    name: "Mara Plain Track",
    type: "dirt",
    via: [{ x: 756, y: 2431 }, { x: 761, y: 2432 }, { x: 765, y: 2431 }, { x: 777, y: 2419 }, { x: 789, y: 2407 }, { x: 797, y: 2393 }, { x: 798, y: 2383 }, { x: 807, y: 2377 }, { x: 817, y: 2378 }, { x: 825, y: 2382 }],
  },
  {
    a: "j7",
    b: "j12",
    name: "Mara Plain Track",
    type: "dirt",
    via: [{ x: 827, y: 2391 }, { x: 835, y: 2393 }, { x: 838, y: 2397 }, { x: 841, y: 2396 }, { x: 842, y: 2392 }, { x: 845, y: 2388 }],
  },
  {
    a: "j7",
    b: "j6",
    name: "River Drive",
    type: "dirt",
    via: [{ x: 830, y: 2383 }, { x: 842, y: 2365 }, { x: 854, y: 2348 }, { x: 866, y: 2331 }, { x: 867, y: 2308 }, { x: 868, y: 2286 }, { x: 866, y: 2282 }, { x: 868, y: 2280 }, { x: 875, y: 2282 }, { x: 880, y: 2280 }, { x: 889, y: 2271 }, { x: 904, y: 2267 }],
  },
  {
    a: "j6",
    b: "j14",
    name: "River Drive",
    type: "dirt",
    via: [{ x: 902, y: 2251 }, { x: 902, y: 2238 }, { x: 901, y: 2224 }, { x: 899, y: 2221 }, { x: 899, y: 2214 }, { x: 896, y: 2206 }, { x: 898, y: 2196 }, { x: 896, y: 2191 }, { x: 899, y: 2182 }, { x: 900, y: 2170 }, { x: 900, y: 2157 }, { x: 900, y: 2143 }, { x: 905, y: 2134 }, { x: 906, y: 2121 }, { x: 906, y: 2108 }, { x: 899, y: 2101 }, { x: 899, y: 2085 }, { x: 901, y: 2081 }, { x: 898, y: 2079 }, { x: 895, y: 2065 }, { x: 891, y: 2056 }, { x: 891, y: 2041 }, { x: 893, y: 2029 }, { x: 895, y: 2017 }, { x: 892, y: 2009 }, { x: 895, y: 1991 }, { x: 892, y: 1982 }, { x: 892, y: 1972 }, { x: 886, y: 1963 }, { x: 879, y: 1962 }, { x: 878, y: 1959 }, { x: 879, y: 1940 }, { x: 880, y: 1922 }],
  },
  {
    a: "j14",
    b: "jw",
    name: "River Drive",
    type: "dirt",
    via: [{ x: 875, y: 1903 }, { x: 864, y: 1908 }, { x: 853, y: 1913 }, { x: 840, y: 1915 }, { x: 825, y: 1911 }, { x: 811, y: 1913 }, { x: 798, y: 1909 }],
  },
  // The drawn road along the river's south bank, linking River Drive to the
  // Acacia Loop corridor directly (traced off the poster like every other edge).
  {
    a: "j14",
    b: "j15",
    name: "Riverbank Track",
    type: "dirt",
    via: [{ x: 902, y: 1908 }, { x: 930, y: 1901 }, { x: 935, y: 1910 }, { x: 939, y: 1906 }, { x: 947, y: 1907 }, { x: 965, y: 1892 }, { x: 984, y: 1884 }, { x: 1001, y: 1871 }, { x: 1019, y: 1872 }, { x: 1030, y: 1862 }, { x: 1052, y: 1867 }, { x: 1073, y: 1861 }],
  },
  {
    a: "j6",
    b: "j2",
    name: "River Drive",
    type: "dirt",
    via: [{ x: 919, y: 2257 }, { x: 922, y: 2258 }, { x: 936, y: 2246 }, { x: 950, y: 2234 }, { x: 954, y: 2234 }, { x: 955, y: 2229 }, { x: 968, y: 2218 }, { x: 981, y: 2207 }, { x: 984, y: 2199 }, { x: 994, y: 2194 }, { x: 995, y: 2189 }, { x: 998, y: 2187 }, { x: 1006, y: 2178 }, { x: 1021, y: 2167 }, { x: 1026, y: 2160 }, { x: 1029, y: 2154 }, { x: 1032, y: 2134 }, { x: 1045, y: 2124 }, { x: 1046, y: 2108 }, { x: 1057, y: 2095 }, { x: 1060, y: 2080 }, { x: 1059, y: 2074 }, { x: 1059, y: 2058 }, { x: 1055, y: 2047 }, { x: 1059, y: 2036 }],
  },
  {
    a: "j2",
    b: "j15",
    name: "Acacia Loop",
    type: "dirt",
    via: [{ x: 1078, y: 2005 }, { x: 1087, y: 1985 }, { x: 1088, y: 1966 }, { x: 1087, y: 1952 }, { x: 1086, y: 1938 }, { x: 1084, y: 1923 }, { x: 1077, y: 1910 }, { x: 1070, y: 1896 }, { x: 1071, y: 1885 }, { x: 1072, y: 1873 }, { x: 1076, y: 1865 }],
  },
  {
    a: "j15",
    b: "j16",
    name: "Acacia Loop",
    type: "dirt",
    crossing: true,
    via: [{ x: 1083, y: 1856 }, { x: 1094, y: 1848 }, { x: 1099, y: 1837 }, { x: 1104, y: 1837 }, { x: 1105, y: 1835 }, { x: 1105, y: 1830 }, { x: 1104, y: 1828 }, { x: 1107, y: 1811 }, { x: 1104, y: 1807 }, { x: 1104, y: 1805 }, { x: 1110, y: 1789 }, { x: 1116, y: 1783 }, { x: 1121, y: 1773 }, { x: 1119, y: 1758 }, { x: 1126, y: 1744 }, { x: 1132, y: 1730 }, { x: 1135, y: 1710 }, { x: 1146, y: 1700 }, { x: 1156, y: 1691 }, { x: 1161, y: 1689 }, { x: 1174, y: 1678 }, { x: 1186, y: 1668 }, { x: 1197, y: 1662 }, { x: 1213, y: 1657 }, { x: 1222, y: 1652 }, { x: 1226, y: 1647 }, { x: 1230, y: 1647 }, { x: 1236, y: 1654 }, { x: 1237, y: 1660 }, { x: 1247, y: 1672 }, { x: 1261, y: 1674 }, { x: 1277, y: 1661 }, { x: 1284, y: 1662 }, { x: 1289, y: 1659 }, { x: 1296, y: 1651 }, { x: 1304, y: 1643 }, { x: 1315, y: 1636 }, { x: 1326, y: 1630 }],
  },
  {
    a: "j16",
    b: "j3",
    name: "Acacia Loop",
    type: "dirt",
    via: [{ x: 1333, y: 1609 }, { x: 1334, y: 1595 }, { x: 1340, y: 1582 }, { x: 1346, y: 1569 }, { x: 1351, y: 1555 }, { x: 1351, y: 1535 }, { x: 1351, y: 1516 }, { x: 1357, y: 1508 }, { x: 1364, y: 1503 }, { x: 1368, y: 1487 }, { x: 1369, y: 1471 }],
  },
  {
    a: "j3",
    b: "j11",
    name: "Acacia Loop",
    type: "dirt",
    via: [{ x: 1376, y: 1454 }, { x: 1376, y: 1432 }, { x: 1381, y: 1420 }, { x: 1382, y: 1412 }, { x: 1379, y: 1400 }, { x: 1377, y: 1388 }, { x: 1382, y: 1376 }, { x: 1386, y: 1365 }, { x: 1393, y: 1352 }, { x: 1394, y: 1346 }, { x: 1397, y: 1343 }, { x: 1398, y: 1336 }, { x: 1394, y: 1328 }, { x: 1396, y: 1311 }, { x: 1400, y: 1298 }],
  },
  {
    a: "j11",
    b: "j10",
    name: "Acacia Loop",
    type: "dirt",
    via: [{ x: 1398, y: 1283 }, { x: 1401, y: 1280 }, { x: 1404, y: 1263 }, { x: 1399, y: 1249 }, { x: 1394, y: 1241 }, { x: 1394, y: 1236 }, { x: 1397, y: 1214 }, { x: 1395, y: 1207 }, { x: 1395, y: 1201 }, { x: 1401, y: 1193 }, { x: 1403, y: 1181 }, { x: 1401, y: 1177 }, { x: 1403, y: 1162 }, { x: 1405, y: 1147 }, { x: 1406, y: 1138 }, { x: 1404, y: 1136 }, { x: 1405, y: 1123 }, { x: 1402, y: 1116 }, { x: 1406, y: 1116 }, { x: 1410, y: 1110 }, { x: 1417, y: 1106 }, { x: 1424, y: 1106 }, { x: 1435, y: 1109 }, { x: 1450, y: 1125 }, { x: 1465, y: 1141 }, { x: 1480, y: 1158 }, { x: 1494, y: 1170 }],
  },
  {
    a: "j10",
    b: "yellowthorn",
    name: "Acacia Loop",
    type: "dirt",
    via: [{ x: 1502, y: 1172 }, { x: 1504, y: 1174 }, { x: 1510, y: 1183 }, { x: 1509, y: 1187 }, { x: 1510, y: 1209 }, { x: 1509, y: 1218 }, { x: 1514, y: 1229 }, { x: 1520, y: 1231 }, { x: 1532, y: 1231 }, { x: 1547, y: 1239 }, { x: 1554, y: 1240 }, { x: 1564, y: 1244 }, { x: 1575, y: 1244 }, { x: 1584, y: 1247 }],
  },
  {
    a: "j11",
    b: "kingfisher",
    name: "Western Track",
    type: "dirt",
    via: [{ x: 1397, y: 1284 }, { x: 1394, y: 1279 }, { x: 1391, y: 1278 }, { x: 1387, y: 1278 }, { x: 1382, y: 1281 }, { x: 1375, y: 1280 }, { x: 1368, y: 1271 }, { x: 1363, y: 1269 }, { x: 1356, y: 1261 }, { x: 1355, y: 1245 }, { x: 1348, y: 1227 }, { x: 1349, y: 1214 }, { x: 1347, y: 1207 }, { x: 1350, y: 1195 }, { x: 1351, y: 1181 }, { x: 1352, y: 1168 }, { x: 1356, y: 1159 }, { x: 1362, y: 1157 }, { x: 1362, y: 1153 }, { x: 1359, y: 1151 }, { x: 1358, y: 1141 }, { x: 1349, y: 1132 }, { x: 1340, y: 1116 }, { x: 1329, y: 1103 }, { x: 1324, y: 1091 }, { x: 1321, y: 1078 }, { x: 1316, y: 1068 }, { x: 1305, y: 1059 }, { x: 1298, y: 1048 }, { x: 1286, y: 1041 }, { x: 1279, y: 1028 }, { x: 1271, y: 1021 }, { x: 1266, y: 1015 }, { x: 1262, y: 1000 }, { x: 1258, y: 985 }, { x: 1255, y: 981 }, { x: 1247, y: 975 }, { x: 1234, y: 970 }, { x: 1220, y: 964 }, { x: 1204, y: 954 }, { x: 1195, y: 944 }, { x: 1188, y: 934 }, { x: 1179, y: 941 }, { x: 1167, y: 953 }, { x: 1153, y: 954 }, { x: 1146, y: 960 }, { x: 1136, y: 960 }, { x: 1125, y: 952 }, { x: 1117, y: 952 }, { x: 1105, y: 959 }, { x: 1092, y: 965 }, { x: 1080, y: 966 }, { x: 1074, y: 968 }, { x: 1068, y: 972 }, { x: 1056, y: 990 }, { x: 1042, y: 1005 }, { x: 1038, y: 1007 }, { x: 1031, y: 1006 }, { x: 1023, y: 1012 }, { x: 1016, y: 1011 }, { x: 996, y: 1016 }, { x: 988, y: 1022 }, { x: 975, y: 1036 }, { x: 972, y: 1034 }, { x: 960, y: 1043 }, { x: 953, y: 1044 }],
  },
  {
    a: "j10",
    b: "j4",
    name: "Northern Link",
    type: "dirt",
    via: [{ x: 1500, y: 1174 }, { x: 1504, y: 1166 }, { x: 1510, y: 1163 }],
  },
  {
    a: "j4",
    b: "j8",
    name: "Eastern Circuit",
    type: "dirt",
    via: [{ x: 1527, y: 1135 }, { x: 1538, y: 1116 }, { x: 1547, y: 1107 }, { x: 1553, y: 1098 }],
  },
  {
    a: "j8",
    b: "j5",
    name: "Eastern Circuit",
    type: "dirt",
    via: [{ x: 1576, y: 1096 }, { x: 1594, y: 1097 }, { x: 1612, y: 1098 }, { x: 1633, y: 1106 }, { x: 1655, y: 1113 }, { x: 1673, y: 1114 }, { x: 1680, y: 1113 }, { x: 1690, y: 1108 }, { x: 1698, y: 1109 }, { x: 1709, y: 1115 }, { x: 1721, y: 1120 }, { x: 1723, y: 1125 }, { x: 1740, y: 1127 }, { x: 1757, y: 1128 }, { x: 1773, y: 1144 }, { x: 1790, y: 1159 }, { x: 1797, y: 1178 }, { x: 1809, y: 1195 }, { x: 1822, y: 1212 }, { x: 1840, y: 1222 }, { x: 1845, y: 1227 }],
  },
  {
    a: "j8",
    b: "j9",
    name: "Naribo Track",
    type: "dirt",
    via: [{ x: 1562, y: 1078 }, { x: 1566, y: 1069 }, { x: 1581, y: 1054 }, { x: 1588, y: 1045 }, { x: 1595, y: 1035 }, { x: 1603, y: 1027 }, { x: 1620, y: 1017 }, { x: 1637, y: 1007 }, { x: 1654, y: 997 }, { x: 1670, y: 993 }, { x: 1686, y: 988 }, { x: 1697, y: 987 }, { x: 1712, y: 989 }, { x: 1726, y: 991 }],
  },
  {
    a: "j9",
    b: "naribo",
    name: "Naribo Track",
    type: "dirt",
    via: [{ x: 1732, y: 994 }, { x: 1750, y: 999 }, { x: 1766, y: 1011 }, { x: 1779, y: 1023 }, { x: 1798, y: 1035 }, { x: 1810, y: 1035 }, { x: 1822, y: 1036 }, { x: 1837, y: 1024 }],
  },
  {
    a: "j9",
    b: "rhinogate",
    name: "Rhino Gate Road",
    type: "graded",
    crossing: true,
    via: [{ x: 1737, y: 988 }, { x: 1752, y: 974 }, { x: 1764, y: 971 }, { x: 1767, y: 968 }, { x: 1776, y: 967 }, { x: 1791, y: 971 }, { x: 1803, y: 976 }, { x: 1806, y: 980 }, { x: 1824, y: 980 }, { x: 1835, y: 984 }, { x: 1848, y: 984 }, { x: 1861, y: 979 }, { x: 1878, y: 981 }, { x: 1893, y: 974 }, { x: 1915, y: 980 }, { x: 1923, y: 984 }, { x: 1926, y: 973 }, { x: 1926, y: 967 }, { x: 1942, y: 950 }, { x: 1957, y: 933 }, { x: 1968, y: 925 }, { x: 1979, y: 919 }, { x: 1990, y: 914 }, { x: 2013, y: 911 }, { x: 2028, y: 911 }, { x: 2036, y: 921 }, { x: 2037, y: 920 }],
  },
  {
    a: "j3",
    b: "choroa",
    name: "Choroa Track",
    type: "dirt",
    via: [{ x: 1384, y: 1465 }, { x: 1387, y: 1470 }, { x: 1394, y: 1471 }, { x: 1404, y: 1476 }, { x: 1409, y: 1481 }, { x: 1414, y: 1489 }, { x: 1414, y: 1503 }, { x: 1414, y: 1517 }, { x: 1418, y: 1539 }, { x: 1423, y: 1557 }, { x: 1429, y: 1574 }, { x: 1431, y: 1577 }, { x: 1436, y: 1579 }, { x: 1448, y: 1571 }, { x: 1461, y: 1563 }, { x: 1470, y: 1560 }, { x: 1484, y: 1564 }, { x: 1498, y: 1567 }, { x: 1512, y: 1568 }, { x: 1527, y: 1570 }, { x: 1543, y: 1581 }, { x: 1553, y: 1583 }, { x: 1561, y: 1583 }, { x: 1572, y: 1571 }, { x: 1581, y: 1566 }, { x: 1601, y: 1568 }],
  },
  {
    a: "j16",
    b: "choroa",
    name: "Bush Track",
    type: "4x4",
    via: [{ x: 1339, y: 1623 }, { x: 1347, y: 1627 }, { x: 1357, y: 1614 }, { x: 1377, y: 1612 }, { x: 1391, y: 1601 }, { x: 1405, y: 1590 }, { x: 1413, y: 1586 }, { x: 1420, y: 1584 }, { x: 1432, y: 1586 }, { x: 1438, y: 1577 }, { x: 1451, y: 1569 }, { x: 1465, y: 1561 }, { x: 1473, y: 1561 }, { x: 1485, y: 1564 }, { x: 1498, y: 1567 }, { x: 1512, y: 1568 }, { x: 1527, y: 1570 }, { x: 1543, y: 1581 }, { x: 1553, y: 1583 }, { x: 1561, y: 1583 }, { x: 1572, y: 1571 }, { x: 1581, y: 1566 }, { x: 1601, y: 1568 }],
  },
  {
    a: "naribo",
    b: "rhinogate",
    name: "Carissa Plain Track",
    type: "dirt",
    crossing: true,
    via: [{ x: 1837, y: 1024 }, { x: 1848, y: 1015 }, { x: 1865, y: 1006 }, { x: 1868, y: 1008 }, { x: 1876, y: 1008 }, { x: 1885, y: 1000 }, { x: 1905, y: 1000 }, { x: 1918, y: 995 }, { x: 1924, y: 983 }, { x: 1926, y: 967 }, { x: 1929, y: 966 }, { x: 1936, y: 955 }, { x: 1950, y: 941 }, { x: 1964, y: 928 }, { x: 1981, y: 918 }, { x: 1994, y: 913 }, { x: 2007, y: 912 }, { x: 2020, y: 910 }, { x: 2028, y: 911 }, { x: 2036, y: 921 }, { x: 2037, y: 920 }],
  },
];

/** Pixel position of a network node. */
export const NODE_PIXEL = new Map<string, Pixel>(RAW_NODES.map((n) => [n.id, n.pixel]));

export interface RoadGeom {
  name: string;
  type: RoadClass;
  crossing?: boolean;
  pixels: Pixel[];
  /** River-crossing point in pixels, if any. */
  crossPixel?: Pixel;
}

/** Pixel polylines for drawing the base road network. */
export const ROAD_GEOMS: RoadGeom[] = RAW_EDGES.map((e) => {
  const pixels = [NODE_PIXEL.get(e.a)!, ...(e.via ?? []), NODE_PIXEL.get(e.b)!];
  return {
    name: e.name,
    type: e.type,
    crossing: e.crossing,
    pixels,
    crossPixel: e.crossing ? pixels[Math.floor(pixels.length / 2)] : undefined,
  };
});

const ROUTE_NODES: RouteNode[] = RAW_NODES.map((n) => ({ id: n.id, ...pixelWorld(n.pixel.x, n.pixel.y) }));

/** The traced-from-the-poster road network. */
export function createRoadNetwork(): RoadNetwork {
  const edges: RoadEdge[] = RAW_EDGES.map((e) => ({
    a: e.a,
    b: e.b,
    name: e.name,
    type: e.type,
    via: (e.via ?? []).map((p) => pixelWorld(p.x, p.y)),
  }));
  return new RoadNetwork(ROUTE_NODES, edges);
}
