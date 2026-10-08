// What the hub map is given to draw. Shared by the phone's Google map
// (HubMap.tsx) and the browser preview's stand-in (HubMap.web.tsx).

/** live: on duty and reporting · quiet: on duty, phone silent · off: off duty, last seen. */
export type PinKind = "live" | "quiet" | "off";

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  kind: PinKind;
}

export interface MapData {
  pins: MapPin[];
  hub: { lat: number; lng: number } | null;
}

export interface HubMapProps {
  data: MapData;
  /** The driver whose dot was tapped; the screen shows their card. */
  selectedId: string | null;
  onSelect: (driverId: string | null) => void;
  fitLabel: string;
}
