// Design tokens, taken from the Ride91 logo: its green and its charcoal.
//
// The logo green is bright, and white text on it is too faint to read. So a
// green FILL (a button, an active pill) uses `brand` with `onBrand` text, and
// green TEXT on a white card uses `live`, the same hue deepened until it reads.
export const colors = {
  ink: "#434343",        // the logo's charcoal: text, and dark surfaces
  paper: "#F2F4F0",
  card: "#FFFFFF",
  line: "#DADDD6",
  muted: "#6E746B",
  brand: "#69BC46",      // the logo's green: fills
  onBrand: "#1E2A18",    // text and icons on a brand fill
  brandTint: "#E4F3DC",  // a wash of the brand green behind green text
  live: "#3A7A1F",       // green text on white ("paid", amounts, on-track)
  amber: "#E8A317",
  alert: "#BF3F2C",
  white: "#FFFFFF",
  black: "#000000",
};

export const platformColors: Record<string, string> = {
  ride91: "#69BC46",
  uber: "#26282B",
  rapido: "#E8A317",
  ola: "#3B6FD4",
  offline: "#6E746B",
  shift_end: "#434343",
  to_charger: "#7FC4E4",
  charging: "#4FA8D8",
};

export const platformLabels: Record<string, string> = {
  ride91: "Ride91",
  uber: "Uber",
  rapido: "Rapido",
  ola: "Ola",
  offline: "Offline",
  shift_end: "Shift ended",
  to_charger: "To charger",
  charging: "Charging",
};

export const fonts = {
  display: "BricolageGrotesque-Bold",
  displayMed: "BricolageGrotesque-SemiBold",
  ui: "IBMPlexSans-Regular",
  uiMed: "IBMPlexSans-Medium",
  uiBold: "IBMPlexSans-Bold",
  data: "IBMPlexMono-Regular",
  dataMed: "IBMPlexMono-Medium",
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 20 };
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
