// How a driver's state reads in the hub app: one line of what they are doing,
// and the tag beside their name. Shared by the list and the driver's page.
import { formatDuration } from "@/src/i18n";
import { HubText } from "@/src/hub/text";
import { HubDriver } from "@/src/hub/today";
import { STATUS_TONE, Tone } from "@/src/hub/ui";
import { platformLabels } from "@/src/theme";

// One line saying what the driver is doing, for the list and the driver page.
export function doing(d: HubDriver, t: HubText): string {
  if (!d.on_duty) return d.shift_start_time ? `${d.shift_type} · ${d.shift_start_time}` : d.shift_type;
  const what = d.current_state === "charging" ? t.charging
    : d.current_state === "to_charger" ? t.to_charger
    : d.current_platforms.length ? d.current_platforms.map((p) => platformLabels[p] ?? p).join(" + ")
    : t.not_online;
  return `${what} · ${formatDuration(d.on_duty_seconds)}`;
}

// The tag: on duty wins; otherwise where their coming shift stands.
export function tagFor(d: HubDriver, t: HubText): { tone: Tone; label: string } {
  if (d.on_duty) return { tone: d.tracking === "stopped" ? "warn" : "ok", label: t.on_duty };
  if (d.shift_status === "alarm_pending" || d.shift_status === "no_shift_time") return { tone: "mute", label: t.off_duty };
  return { tone: STATUS_TONE[d.shift_status] ?? "mute", label: t.status[d.shift_status] ?? d.shift_status };
}
