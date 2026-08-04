// Loads Bricolage Grotesque + IBM Plex families from Google Fonts CDN.
// Falls through on error so the app still boots (falls back to system fonts).
import { useFonts } from "expo-font";

const G = "https://raw.githubusercontent.com/google/fonts/main";

export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({
    "BricolageGrotesque-Bold": `${G}/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz%2Cwdth%2Cwght%5D.ttf`,
    "BricolageGrotesque-SemiBold": `${G}/ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz%2Cwdth%2Cwght%5D.ttf`,
    "IBMPlexSans-Regular": `${G}/ofl/ibmplexsans/IBMPlexSans-Regular.ttf`,
    "IBMPlexSans-Medium": `${G}/ofl/ibmplexsans/IBMPlexSans-Medium.ttf`,
    "IBMPlexSans-Bold": `${G}/ofl/ibmplexsans/IBMPlexSans-Bold.ttf`,
    "IBMPlexMono-Regular": `${G}/ofl/ibmplexmono/IBMPlexMono-Regular.ttf`,
    "IBMPlexMono-Medium": `${G}/ofl/ibmplexmono/IBMPlexMono-Medium.ttf`,
  });
