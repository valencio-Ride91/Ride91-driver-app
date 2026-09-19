// Loads Bricolage Grotesque + IBM Plex families from files bundled in the app.
//
// These used to be fetched from raw.githubusercontent.com on every cold start.
// Because the root layout holds the splash screen until font loading settles,
// a slow or blocked network made the app look like it was never opening. They
// are now bundled, so startup does no network I/O and works offline.
//
// Two of the old URLs were also wrong: google/fonts has replaced the static
// IBM Plex Sans weights with a single variable font, so Regular/Medium/Bold
// were 404ing and that text silently fell back to a system font. The static
// weights below come from IBM's own release, so the weights are real.
//
// Bricolage ships only as a variable font, so Bold and SemiBold point at the
// same file — same as before. Both names resolve, but they render identically;
// giving them distinct weights needs static instances of that family.
//
// Fonts are OFL licensed, which permits bundling.
import { useFonts } from "expo-font";

export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({
    "BricolageGrotesque-Bold": require("@/assets/fonts/BricolageGrotesque-Variable.ttf"),
    "BricolageGrotesque-SemiBold": require("@/assets/fonts/BricolageGrotesque-Variable.ttf"),
    "IBMPlexSans-Regular": require("@/assets/fonts/IBMPlexSans-Regular.ttf"),
    "IBMPlexSans-Medium": require("@/assets/fonts/IBMPlexSans-Medium.ttf"),
    "IBMPlexSans-Bold": require("@/assets/fonts/IBMPlexSans-Bold.ttf"),
    "IBMPlexMono-Regular": require("@/assets/fonts/IBMPlexMono-Regular.ttf"),
    "IBMPlexMono-Medium": require("@/assets/fonts/IBMPlexMono-Medium.ttf"),
  });
