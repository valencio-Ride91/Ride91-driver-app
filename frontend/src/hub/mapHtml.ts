// The page behind the hub map: OpenStreetMap drawn by Leaflet inside a web
// view. It needs no Google Maps key and no location permission — the dots are
// the drivers' positions as the server last heard them, not this phone's.
//
// The page is built once. After that the app only sends it new positions
// (`window.setData`), so the map keeps its place while the dots move. Tapping a
// dot's "Open" sends the driver's id back to the app.
//
// Leaflet is loaded from unpkg with its published checksums, so the web view
// refuses the script if it is ever not byte-for-byte Leaflet 1.9.4.

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  name: string;
  /** What the driver is doing, and when they were last seen. */
  line: string;
  seen: string;
  color: string;
  faded: boolean;
}

export interface MapData {
  pins: MapPin[];
  hub: { lat: number; lng: number; name: string } | null;
}

export interface MapLabels {
  open: string;
  hub: string;
  fit: string;
  failed: string;
}

// Safe to drop inside a <script> block: no "</script>" can appear in it.
const embed = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function mapHtml(initial: MapData, labels: MapLabels): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  html, body, #map { height: 100%; margin: 0; background: #F2F4F0; }
  body { font-family: -apple-system, Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif; }
  .pin { display: flex; flex-direction: column; align-items: center; }
  .dot { width: 18px; height: 18px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.45); box-sizing: border-box; }
  .dot.hub { border-radius: 4px; background: #434343; }
  .lbl { margin-top: 2px; padding: 1px 6px; border-radius: 8px; background: rgba(255,255,255,.92); color: #434343;
         font-size: 11px; font-weight: 700; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis;
         box-shadow: 0 1px 2px rgba(0,0,0,.25); }
  .faded { opacity: .6; }
  .pop b { font-size: 15px; color: #434343; }
  .pop div { font-size: 12px; color: #6E746B; margin-top: 2px; }
  .pop button { margin-top: 8px; width: 100%; padding: 8px 12px; border: 0; border-radius: 8px; background: #69BC46;
                color: #1E2A18; font-size: 14px; font-weight: 700; }
  .fit { background: #fff; border: 0; padding: 7px 10px; font-size: 12px; font-weight: 700; color: #434343; border-radius: 4px; }
  #fail { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
          text-align: center; color: #6E746B; font-size: 14px; }
  #fail[hidden] { display: none; }
</style>
</head>
<body>
<div id="map"></div>
<div id="fail" hidden></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(function () {
  var LABELS = ${embed(labels)};
  var data = ${embed(initial)};

  function send(m) {
    var s = JSON.stringify(m);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else if (window.parent !== window) window.parent.postMessage(s, "*");
  }

  if (typeof L === "undefined") {
    var f = document.getElementById("fail");
    f.textContent = LABELS.failed;
    f.hidden = false;
    window.setData = function () {};
    send({ failed: true });
    return;
  }

  var map = L.map("map", { zoomControl: false, attributionControl: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "\\u00a9 OpenStreetMap",
  }).addTo(map);
  // No fix and no hub position: the whole country rather than a guessed city.
  map.setView([22.0, 79.0], 5);

  var markers = {};
  var hubMarker = null;
  var placed = false;     // the first time there is something to show, frame it

  function icon(color, label, cls) {
    var wrap = document.createElement("div");
    wrap.className = "pin" + (cls ? " " + cls : "");
    var dot = document.createElement("div");
    dot.className = "dot" + (color ? "" : " hub");
    if (color) dot.style.background = color;
    var lbl = document.createElement("div");
    lbl.className = "lbl";
    lbl.textContent = label;
    wrap.appendChild(dot);
    wrap.appendChild(lbl);
    return L.divIcon({ html: wrap, className: "", iconSize: [120, 40], iconAnchor: [60, 9] });
  }

  function popup(p) {
    var el = document.createElement("div");
    el.className = "pop";
    var b = document.createElement("b");
    b.textContent = p.name;
    el.appendChild(b);
    [p.line, p.seen].forEach(function (t) {
      if (!t) return;
      var d = document.createElement("div");
      d.textContent = t;
      el.appendChild(d);
    });
    var btn = document.createElement("button");
    btn.textContent = LABELS.open;
    btn.onclick = function () { send({ open: p.id }); };
    el.appendChild(btn);
    return el;
  }

  function points() {
    var pts = data.pins.map(function (p) { return [p.lat, p.lng]; });
    if (data.hub) pts.push([data.hub.lat, data.hub.lng]);
    return pts;
  }

  function fit() {
    var pts = points();
    if (pts.length === 0) return;
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 15 });
  }

  function draw() {
    var keep = {};
    data.pins.forEach(function (p) {
      keep[p.id] = true;
      var m = markers[p.id];
      if (!m) {
        m = markers[p.id] = L.marker([p.lat, p.lng], { keyboard: false }).addTo(map);
        m.bindPopup("", { closeButton: false, minWidth: 150 });
      } else {
        m.setLatLng([p.lat, p.lng]);
      }
      m.setIcon(icon(p.color, p.name, p.faded ? "faded" : ""));
      m.setZIndexOffset(p.faded ? 0 : 500);
      m.setPopupContent(popup(p));
    });
    Object.keys(markers).forEach(function (id) {
      if (keep[id]) return;
      map.removeLayer(markers[id]);
      delete markers[id];
    });
    if (hubMarker) { map.removeLayer(hubMarker); hubMarker = null; }
    if (data.hub) {
      hubMarker = L.marker([data.hub.lat, data.hub.lng], {
        icon: icon(null, data.hub.name || LABELS.hub), interactive: false, zIndexOffset: -500,
      }).addTo(map);
    }
    if (!placed && points().length) { placed = true; fit(); }
  }

  var Fit = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var b = L.DomUtil.create("button", "fit leaflet-bar");
      b.textContent = LABELS.fit;
      L.DomEvent.disableClickPropagation(b);
      b.onclick = fit;
      return b;
    },
  });
  map.addControl(new Fit());
  L.control.zoom({ position: "bottomright" }).addTo(map);

  window.setData = function (next) { data = next; draw(); };
  window.addEventListener("message", function (e) {
    if (e.data && e.data.ride91Map) window.setData(e.data.ride91Map);
  });

  draw();
  send({ ready: true });
})();
</script>
</body>
</html>`;
}
