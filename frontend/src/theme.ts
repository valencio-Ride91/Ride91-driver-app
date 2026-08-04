// Design tokens from the Ride91 spec. Do not use a default template look.
export const colors = {
  ink: "#10231C",
  paper: "#EEF1EC",
  card: "#FFFFFF",
  line: "#D6DCD5",
  muted: "#67756D",
  live: "#0B7A4B",
  amber: "#E8A317",
  alert: "#BF3F2C",
  white: "#FFFFFF",
  black: "#000000",
};

export const platformColors: Record<string, string> = {
  ride91: "#0B7A4B",
  uber: "#26282B",
  rapido: "#E8A317",
  ola: "#3B6FD4",
  offline: "#67756D",
  shift_end: "#10231C",
  charging: "#4FA8D8",
};

export const platformLabels: Record<string, string> = {
  ride91: "Ride91",
  uber: "Uber",
  rapido: "Rapido",
  ola: "Ola",
  offline: "Offline",
  shift_end: "Shift ended",
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
