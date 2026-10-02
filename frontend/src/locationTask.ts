// Background location task. Registered at module load (imported from the app
// entry) so Android can run it even when the app is backgrounded or the screen
// is off. It reads the stored auth token and POSTs each fix to /tracking/ping,
// which the backend bridges onto the admin live map.
import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";

export const LOCATION_TASK = "ride91-location-updates";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;
const AUTH_TOKEN_KEY = "ride91.token";   // same key as src/api.ts (stored JSON-encoded)

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locs = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locs || locs.length === 0) return;
  const last = locs[locs.length - 1];

  let token: string | null = null;
  try {
    const raw = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    token = raw ? JSON.parse(raw) : null;
  } catch {
    token = null;
  }
  if (!token) return;   // not signed in — nothing to report

  const speed = last.coords.speed;
  try {
    await fetch(`${BASE}/api/tracking/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recorded_at: new Date(last.timestamp).toISOString(),
        lat: last.coords.latitude,
        lng: last.coords.longitude,
        accuracy_m: last.coords.accuracy ?? undefined,
        speed_kmph: speed != null && speed >= 0 ? Math.round(speed * 3.6 * 10) / 10 : undefined,
      }),
    });
  } catch {
    // offline — the next fix will report; nothing to do
  }
});
