// PHASE 2 SCAFFOLD (Module A) — not active. To activate (when agreed):
//   npm i -D @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
//   npm run build && npx cap add ios && npx cap add android && npx cap sync
// The generated ios/ + android/ shells are derived — build artefacts, not
// committed until we actually ship them. Store accounts in Solio's name.
// The PWA service worker + tile cache keep working inside the wrap.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.soliogamereserve.map",
  appName: "Solio Game Reserve",
  webDir: "dist",
  server: { androidScheme: "https" },
};

export default config;
