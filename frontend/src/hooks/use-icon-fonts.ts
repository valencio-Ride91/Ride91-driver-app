// Icon font loader for Expo apps. Fonts are loaded from a CDN only under
// Expo Go (StoreClient) — that's where react-native-vector-icons' .ttf
// files come back as 0 bytes from Metro's asset resolver on Android.
// Native dev/prod builds and web pass an empty map, so useFonts resolves
// to [true, null] immediately via autolinking / web stubs.
//
// The CDN pins a specific version of the (now-legacy) @expo/vector-icons
// package — that npm tarball is cached forever on jsdelivr and still ships
// the exact .ttf files react-native-vector-icons expects, so keeping this
// pin is a stable minimal way to feed Expo Go the fonts without dragging
// the legacy package back into the app's dependency graph.
import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "15.1.1";

// short internal fontName (what the library queries) -> CDN .ttf file name
const ICON_FAMILIES: Record<string, string> = {
  anticon: "AntDesign",
  entypo: "Entypo",
  evilicons: "EvilIcons",
  feather: "Feather",
  FontAwesome: "FontAwesome",
  Fontisto: "Fontisto",
  foundation: "Foundation",
  ionicons: "Ionicons",
  "material-community": "MaterialCommunityIcons",
  material: "MaterialIcons",
  octicons: "Octicons",
  "simple-line-icons": "SimpleLineIcons",
  zocial: "Zocial",
  // FontAwesome5 style variants (key = `FontAwesome5Free-<style>`)
  "FontAwesome5Free-Regular": "FontAwesome5_Regular",
  "FontAwesome5Free-Solid": "FontAwesome5_Solid",
  "FontAwesome5Free-Brand": "FontAwesome5_Brands",
  // FontAwesome6 style variants (key = `FontAwesome6Free-<style>`)
  "FontAwesome6Free-Regular": "FontAwesome6_Regular",
  "FontAwesome6Free-Solid": "FontAwesome6_Solid",
  "FontAwesome6Free-Brand": "FontAwesome6_Brands",
};

const cdnUrl = (file: string): string =>
  `https://cdn.jsdelivr.net/npm/@expo/vector-icons@${ICON_VECTOR_VERSION}/build/vendor/react-native-vector-icons/Fonts/${file}.ttf`;

const iconFontMap = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(ICON_FAMILIES).map(([key, file]) => [key, cdnUrl(file)]),
  );

export const useIconFonts = (): readonly [boolean, Error | null] =>
  useFonts(
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? iconFontMap()
      : {},
  );
