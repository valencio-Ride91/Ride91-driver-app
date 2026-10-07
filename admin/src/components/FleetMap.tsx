// One map component for the whole admin panel (Live map, a driver's Activity
// log). It draws on Google Maps when a Google Maps key has been saved in
// Settings, and on OpenStreetMap otherwise — or if Google refuses the key, so
// a wrong key never leaves the hub looking at a blank box.
//
// Callers describe pins; they never touch either map library.
import { useEffect, useRef, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { api } from "../api";

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  color: string;
  label?: string;        // short text inside the pin, e.g. a number
  faded?: boolean;       // e.g. a stale position
  title: string;         // first line of the pop-up
  lines?: string[];      // further lines of the pop-up
}

interface Props {
  pins: MapPin[];
  // "always": keep every pin in view whenever the pins change.
  // "once":   bring the pins into view the first time there are any, then
  //           leave the view alone (so a refresh does not undo the user's pan).
  fit: "always" | "once";
}

const INDIA: [number, number] = [22.0, 79.0];
const INDIA_ZOOM = 5;

// ---- which map to use ------------------------------------------------------

let configPromise: Promise<string> | null = null;
/** The Google Maps key saved in Settings, or "" for none. Asked for once. */
function mapKey(): Promise<string> {
  if (!configPromise) {
    configPromise = api
      .get<{ google_maps_key: string | null }>("/admin/map-config")
      .then((r) => r.google_maps_key ?? "")
      .catch(() => "");                       // older server: no Google key
  }
  return configPromise;
}

const AUTH_FAILED = "ride91:gmaps-auth-failed";
let googleRefused = false;

// Google takes its time (some 20 seconds) to say a key is no good, and shows
// an empty box meanwhile. So a refusal is remembered for the browser session,
// per key: later pages go straight to OpenStreetMap, and a new key gets a
// fresh try.
const REFUSED_KEY = "ride91.gmaps.refused";
function refusedBefore(key: string): boolean {
  try {
    return sessionStorage.getItem(REFUSED_KEY) === key;
  } catch {
    return false;
  }
}
function rememberRefusal(key: string) {
  try {
    sessionStorage.setItem(REFUSED_KEY, key);
  } catch {
    // private window: just ask Google again next time
  }
}
let googlePromise: Promise<any> | null = null;
/** Load the Google Maps script once. Rejects if it cannot be loaded. */
function loadGoogle(key: string): Promise<any> {
  if (!googlePromise) {
    googlePromise = new Promise((resolve, reject) => {
      const w = window as any;
      // Google calls this when the key is wrong, not allowed on this site, or
      // the Maps JavaScript API is not switched on for it.
      w.gm_authFailure = () => {
        googleRefused = true;
        rememberRefusal(key);
        window.dispatchEvent(new Event(AUTH_FAILED));
      };
      w.__ride91MapsReady = () => resolve(w.google.maps);
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=__ride91MapsReady`;
      s.async = true;
      s.onerror = () => reject(new Error("google_maps_script_failed"));
      document.head.appendChild(s);
    });
  }
  return googlePromise;
}

type Engine = "loading" | "google" | "osm";

export default function FleetMap({ pins, fit }: Props) {
  const [engine, setEngine] = useState<Engine>("loading");
  const [gmaps, setGmaps] = useState<any>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fallBack = () => {
      if (!alive) return;
      setEngine("osm");
      setNote("Google Maps did not accept the key saved in Settings, so this is OpenStreetMap.");
    };
    mapKey().then((key) => {
      if (!alive) return;
      if (!key) return setEngine("osm");
      if (googleRefused || refusedBefore(key)) return fallBack();
      loadGoogle(key)
        .then((g) => {
          if (!alive) return;
          setGmaps(g);
          setEngine("google");
        })
        .catch(fallBack);
    });
    window.addEventListener(AUTH_FAILED, fallBack);
    return () => {
      alive = false;
      window.removeEventListener(AUTH_FAILED, fallBack);
    };
  }, []);

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }} data-testid="fleet-map" data-engine={engine}>
      {engine === "loading" ? <div className="empty" style={{ paddingTop: 40 }}>Loading map…</div>
        : engine === "google" ? <GoogleView g={gmaps} pins={pins} fit={fit} />
        : <LeafletView pins={pins} fit={fit} />}
      {note ? (
        <div className="muted-sm" style={{ position: "absolute", left: 8, bottom: 8, zIndex: 1000, background: "rgba(255,255,255,.92)", padding: "3px 8px", borderRadius: 6 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

const positionsKey = (pins: MapPin[]) => pins.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");

// ---- Google Maps -----------------------------------------------------------

function googleIcon(g: any, p: MapPin) {
  return {
    path: g.SymbolPath.CIRCLE,
    scale: p.label ? 11 : 7,
    fillColor: p.color,
    fillOpacity: p.faded ? 0.5 : 1,
    strokeColor: "#ffffff",
    strokeWeight: 2,
  };
}

function popupNode(p: MapPin): HTMLElement {
  // Built with textContent, so nothing a driver typed is ever read as HTML.
  const box = document.createElement("div");
  box.style.minWidth = "170px";
  const t = document.createElement("div");
  t.style.fontWeight = "700";
  t.textContent = p.title;
  box.appendChild(t);
  for (const line of p.lines ?? []) {
    const d = document.createElement("div");
    d.style.fontSize = "12px";
    d.style.color = "#67756D";
    d.textContent = line;
    box.appendChild(d);
  }
  return box;
}

function GoogleView({ g, pins, fit }: { g: any; pins: MapPin[]; fit: Props["fit"] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const info = useRef<any>(null);
  const markers = useRef(new Map<string, { marker: any; pin: MapPin }>());
  const fitted = useRef<string | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = new g.Map(el.current, {
      center: { lat: INDIA[0], lng: INDIA[1] },
      zoom: INDIA_ZOOM,
      streetViewControl: false,
      mapTypeControl: true,
      fullscreenControl: true,
    });
    info.current = new g.InfoWindow();
    g.event.addListenerOnce(map.current, "tilesloaded", () => setDrawn(true));
  }, [g]);

  // Bring the markers in line with `pins`: add new ones, move or restyle the
  // ones that changed, drop the ones that are gone. Markers are reused so an
  // open pop-up survives the Live map's refresh.
  useEffect(() => {
    if (!map.current) return;
    const seen = new Set<string>();
    for (const p of pins) {
      seen.add(p.id);
      const pos = { lat: p.lat, lng: p.lng };
      const label = p.label ? { text: p.label, color: "#ffffff", fontSize: "11px", fontWeight: "700" } : undefined;
      const have = markers.current.get(p.id);
      if (have) {
        have.marker.setPosition(pos);
        have.marker.setIcon(googleIcon(g, p));
        have.marker.setLabel(label ?? null);
        have.pin = p;
      } else {
        const marker = new g.Marker({ map: map.current, position: pos, icon: googleIcon(g, p), label, title: p.title });
        const entry = { marker, pin: p };
        marker.addListener("click", () => {
          info.current.setContent(popupNode(entry.pin));
          info.current.open({ map: map.current, anchor: marker });
        });
        markers.current.set(p.id, entry);
      }
    }
    for (const [id, m] of markers.current) {
      if (!seen.has(id)) {
        m.marker.setMap(null);
        markers.current.delete(id);
      }
    }

    const key = positionsKey(pins);
    const due = pins.length > 0 && (fit === "always" ? fitted.current !== key : fitted.current === null);
    if (due) {
      fitted.current = key;
      if (pins.length === 1) {
        map.current.setCenter({ lat: pins[0].lat, lng: pins[0].lng });
        map.current.setZoom(15);
      } else {
        const b = new g.LatLngBounds();
        pins.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
        map.current.fitBounds(b, 40);
        // A cluster of presses at one spot would zoom in to the doorstep.
        g.event.addListenerOnce(map.current, "idle", () => {
          if (map.current.getZoom() > 17) map.current.setZoom(17);
        });
      }
    }
  }, [g, pins, fit]);

  return (
    <>
      <div ref={el} style={{ height: "100%", width: "100%" }} />
      {drawn ? null : (
        <div className="empty" style={{ position: "absolute", inset: 0, paddingTop: 40, pointerEvents: "none" }}>Loading Google Maps…</div>
      )}
    </>
  );
}

// ---- OpenStreetMap (Leaflet) -----------------------------------------------

const leafletIcon = (p: MapPin) =>
  p.label
    ? L.divIcon({
        className: "",
        html: `<div style="min-width:20px;height:20px;border-radius:10px;background:${p.color};color:#fff;font:700 11px/20px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 0 0 1px rgba(16,35,28,.35);padding:0 3px;${p.faded ? "opacity:0.5;" : ""}">${p.label.replace(/[<>&]/g, "")}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })
    : L.divIcon({
        className: "",
        html: `<div style="width:14px;height:14px;border-radius:9px;background:${p.color};border:2px solid #fff;box-shadow:0 0 0 2px rgba(16,35,28,.25);${p.faded ? "opacity:0.5;" : ""}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });

function LeafletFit({ pins, fit }: { pins: MapPin[]; fit: Props["fit"] }) {
  const map = useMap();
  const fitted = useRef<string | null>(null);
  const key = positionsKey(pins);
  useEffect(() => {
    const due = pins.length > 0 && (fit === "always" ? fitted.current !== key : fitted.current === null);
    if (!due) return;
    fitted.current = key;
    if (pins.length === 1) map.setView([pins[0].lat, pins[0].lng], 15);
    else map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])), { padding: [30, 30], maxZoom: 17 });
    // `key` stands in for `pins`, which is a new array on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fit, map]);
  return null;
}

function LeafletView({ pins, fit }: { pins: MapPin[]; fit: Props["fit"] }) {
  return (
    <MapContainer center={INDIA} zoom={INDIA_ZOOM} style={{ height: "100%", width: "100%" }}>
      <TileLayer
        attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <LeafletFit pins={pins} fit={fit} />
      {pins.map((p) => (
        <Marker key={p.id} position={[p.lat, p.lng]} icon={leafletIcon(p)}>
          <Popup>
            <div style={{ minWidth: 170 }}>
              <div style={{ fontWeight: 700 }}>{p.title}</div>
              {(p.lines ?? []).map((line, i) => (
                <div key={i} style={{ fontSize: 12, color: "#67756D" }}>{line}</div>
              ))}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
