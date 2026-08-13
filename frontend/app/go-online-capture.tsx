// Go-Online Capture Gate (Part 7).
//
// Once-per-business-day flow the driver has to complete before picking a
// platform (Uber/Rapido/Ola). Sequence:
//   0. Location & permissions sanity — hard-block if > 30 km from hub.
//   1. Guided 20 s walk-around video with four 5 s stages:
//        Front (0-5) → Driver side (5-10) → Back (10-15) → Passenger (15-20).
//   2. One selfie.
//   3. Review + submit. GPS captured at start & end of the recording (server
//      flags for review if movement > 60 m — driver wasn't at the car).
//
// Backend: POST /api/go-online-capture and GET /api/go-online-capture/today.
// Upload runs through the offline sync queue so a flaky connection doesn't
// block the driver from going online — the server dedupes on client_action_id.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  CameraView,
  CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from "expo-camera";
import * as Crypto from "expo-crypto";

import { colors, fonts, radius, spacing } from "@/src/theme";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useTracking } from "@/src/tracking";
import { useSync } from "@/src/sync";

type Phase = "intro" | "walkaround" | "walkaround-done" | "selfie" | "selfie-done" | "review" | "submitting" | "done";

const WALKAROUND_SECS = 20;
const STAGE_SECS = 5;
const HUB_WARN_KM = 3;
const HUB_HARD_BLOCK_KM = 30;

// Progressive on-screen prompts shown over the camera as the driver walks.
const STAGES = [
  { key: "front", label: "Front", tip: "Show the number plate and headlights" },
  { key: "driver", label: "Driver side", tip: "Walk to the driver-side door" },
  { key: "back", label: "Back", tip: "Show the boot and rear number plate" },
  { key: "passenger", label: "Passenger side", tip: "Walk to the passenger side" },
] as const;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export default function GoOnlineCapture() {
  const router = useRouter();
  const { driver } = useAuth();
  const { lat, lng } = useTracking();
  const { enqueue } = useSync();

  const cameraRef = useRef<CameraView>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [facing, setFacing] = useState<CameraType>("back");

  // Captured data
  const [videoB64, setVideoB64] = useState<string | null>(null);
  const [selfieB64, setSelfieB64] = useState<string | null>(null);
  const [walkStartTs, setWalkStartTs] = useState<string | null>(null);
  const [walkEndTs, setWalkEndTs] = useState<string | null>(null);
  const [startPos, setStartPos] = useState<{ lat: number; lng: number } | null>(null);
  const [endPos, setEndPos] = useState<{ lat: number; lng: number } | null>(null);

  // Recording state
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  useEffect(() => {
    if (!camPerm?.granted && camPerm?.canAskAgain !== false) requestCamPerm();
    if (!micPerm?.granted && micPerm?.canAskAgain !== false) requestMicPerm();
  }, [camPerm?.granted, camPerm?.canAskAgain, micPerm?.granted, micPerm?.canAskAgain, requestCamPerm, requestMicPerm]);

  const distanceKm = useMemo(() => {
    if (lat == null || lng == null || driver?.hub_lat == null || driver?.hub_lng == null) return null;
    return haversineKm(lat, lng, driver.hub_lat, driver.hub_lng);
  }, [lat, lng, driver?.hub_lat, driver?.hub_lng]);

  const hubStatus: "ok" | "warn" | "block" | "unknown" =
    distanceKm == null
      ? "unknown"
      : distanceKm > HUB_HARD_BLOCK_KM
        ? "block"
        : distanceKm > HUB_WARN_KM
          ? "warn"
          : "ok";

  const currentStageIdx = Math.min(STAGES.length - 1, Math.floor(elapsed / STAGE_SECS));
  const currentStage = STAGES[currentStageIdx];

  // Recording countdown / stage transitions.
  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [recording]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    setErr(null);
    setWalkStartTs(new Date().toISOString());
    setStartPos(lat != null && lng != null ? { lat, lng } : { lat: 0, lng: 0 });
    setRecording(true);

    let released = false;
    const safety = setTimeout(() => {
      if (released) return;
      released = true;
      setRecording(false);
      setErr("Recording didn't complete. Try again — hold the phone steady and walk around the car.");
    }, (WALKAROUND_SECS + 3) * 1000);

    try {
      const v = (await cameraRef.current.recordAsync({
        maxDuration: WALKAROUND_SECS,
      })) as { uri?: string } | undefined;

      setWalkEndTs(new Date().toISOString());
      setEndPos(lat != null && lng != null ? { lat, lng } : { lat: 0, lng: 0 });

      if (!v || !v.uri) {
        if (Platform.OS === "web") {
          setErr("Video recording isn't available in the web preview. Open in Expo Go on Android.");
        } else {
          setErr("Could not save the recording. Try again.");
        }
        return;
      }
      const b64 = await fileToBase64(v.uri);
      setVideoB64(b64);
      setPhase("walkaround-done");
    } catch (e: any) {
      setErr(`Could not record: ${e?.message ?? "unknown"}`);
    } finally {
      released = true;
      clearTimeout(safety);
      setRecording(false);
    }
  }, [recording, lat, lng]);

  const stopRecording = useCallback(() => {
    try {
      cameraRef.current?.stopRecording();
    } catch {
      // ignore — safety fallback releases the REC state
    }
  }, []);

  const useWebPlaceholderVideo = useCallback(() => {
    setVideoB64("data:video/mp4;base64,AAAAHGZ0eXBpc29tAAAAAWlzb21tcDQyaXNvNgAAAAA=");
    setWalkStartTs(new Date(Date.now() - 20_000).toISOString());
    setWalkEndTs(new Date().toISOString());
    setStartPos(lat != null && lng != null ? { lat, lng } : { lat: 12.9716, lng: 77.5946 });
    setEndPos(lat != null && lng != null ? { lat, lng } : { lat: 12.9716, lng: 77.5946 });
    setErr(null);
    setPhase("walkaround-done");
  }, [lat, lng]);

  const takeSelfie = useCallback(async () => {
    if (!cameraRef.current) return;
    setErr(null);
    try {
      const shot = await cameraRef.current.takePictureAsync({
        quality: 0.55,
        base64: true,
      });
      const b64 = shot?.base64 ? `data:image/jpeg;base64,${shot.base64}` : null;
      if (!b64) throw new Error("no_image");
      setSelfieB64(b64);
      setPhase("selfie-done");
    } catch (e: any) {
      setErr("Could not take selfie. Try again.");
    }
  }, []);

  const submit = useCallback(async () => {
    if (!videoB64 || !selfieB64 || !walkStartTs || !walkEndTs || !startPos || !endPos) {
      setErr("Missing data — please redo the missing step.");
      return;
    }
    setPhase("submitting");
    setErr(null);
    try {
      // Upload through the offline queue — the server dedupes on
      // client_action_id and we don't block the driver on a flaky link.
      await enqueue("/go-online-capture", {
        walkaround_video_b64: videoB64,
        walkaround_video_mime: guessMime(videoB64),
        selfie_photo_b64: selfieB64,
        walkaround_started_at: walkStartTs,
        walkaround_ended_at: walkEndTs,
        start_lat: startPos.lat,
        start_lng: startPos.lng,
        end_lat: endPos.lat,
        end_lng: endPos.lng,
      });
      setPhase("done");
      setTimeout(() => router.replace("/(tabs)"), 900);
    } catch (e: any) {
      const detail = e?.body?.detail;
      if (detail?.code === "too_far_from_hub") {
        setErr(
          `You're ${detail.hub_km?.toFixed?.(1)} km from your hub — beyond the ${detail.limit_km} km limit. Go to your hub and try again.`,
        );
      } else {
        setErr("Could not submit. Please try again.");
      }
      setPhase("review");
    }
  }, [videoB64, selfieB64, walkStartTs, walkEndTs, startPos, endPos, enqueue, router]);

  const cancel = useCallback(() => router.replace("/(tabs)"), [router]);

  // ---- Render ------------------------------------------------------------

  if (!camPerm?.granted) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <Gate
          title="Camera permission needed"
          body="We need your camera to record the 20-second walkaround and take a selfie."
          onGrant={() => requestCamPerm()}
          testID="cap-cam-gate"
        />
      </SafeAreaView>
    );
  }

  if (phase === "intro") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.introWrap}>
          <Text style={styles.kicker}>ONE-TIME · TODAY</Text>
          <Text style={styles.introTitle}>Ready to go online?</Text>
          <Text style={styles.introBody}>
            We&apos;ll take a 20-second walk-around video of the car (Front → Driver → Back → Passenger, 5s each) and one selfie. Do this at your car with the phone in landscape or portrait — both work.
          </Text>

          <View style={styles.hubCard} testID="cap-hub-card">
            <Text style={styles.hubLabel}>Distance from hub</Text>
            <Text
              style={[
                styles.hubValue,
                hubStatus === "block" ? { color: colors.alert } : hubStatus === "warn" ? { color: "#8A5A00" } : null,
              ]}
              testID="cap-hub-km"
            >
              {distanceKm == null ? "waiting for GPS…" : `${distanceKm.toFixed(1)} km`}
            </Text>
            {hubStatus === "warn" ? (
              <Text style={styles.hubHint}>
                You&apos;re a bit far from the hub. You can still go online but ops will see this.
              </Text>
            ) : hubStatus === "block" ? (
              <Text style={styles.hubHint}>
                Too far to go online today. Please come to the hub first.
              </Text>
            ) : hubStatus === "ok" ? (
              <Text style={styles.hubHint}>You&apos;re near the hub — you&apos;re good to go.</Text>
            ) : (
              <Text style={styles.hubHint}>Location will lock in a moment.</Text>
            )}
          </View>

          <View style={styles.actions}>
            <Btn label="Cancel" onPress={cancel} variant="secondary" testID="cap-cancel" />
            <Btn
              label="Start walk-around"
              onPress={() => setPhase("walkaround")}
              disabled={hubStatus === "block"}
              testID="cap-start"
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (phase === "walkaround" || phase === "walkaround-done") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={1} title="Walk-around video" />

        {phase === "walkaround-done" && videoB64 ? (
          <View style={styles.videoDone} testID="cap-video-done">
            <Text style={styles.videoDoneIcon}>✓</Text>
            <Text style={styles.videoDoneText}>Walk-around captured</Text>
          </View>
        ) : (
          <View style={styles.cameraWrap} testID="cap-video-camera">
            {!micPerm?.granted ? (
              <Gate
                title="Microphone permission needed"
                body="Video needs the mic so ops can hear your walk-around."
                onGrant={() => requestMicPerm()}
                testID="cap-mic-gate"
              />
            ) : (
              <>
                <CameraView
                  key="cap-cam-video"
                  ref={cameraRef}
                  style={StyleSheet.absoluteFillObject}
                  facing="back"
                  mode="video"
                  videoQuality="480p"
                  onCameraReady={() => setCameraReady(true)}
                />
                <View style={styles.stageBar} pointerEvents="none">
                  {STAGES.map((s, i) => (
                    <View
                      key={s.key}
                      style={[
                        styles.stageChip,
                        i === currentStageIdx && recording
                          ? styles.stageChipActive
                          : i < currentStageIdx && recording
                            ? styles.stageChipDone
                            : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.stageChipText,
                          i === currentStageIdx && recording ? styles.stageChipTextActive : null,
                        ]}
                      >
                        {s.label}
                      </Text>
                    </View>
                  ))}
                </View>
                <View style={styles.tipStrip} pointerEvents="none">
                  <Text style={styles.tipText} testID="cap-tip">
                    {recording ? currentStage.tip : "Face the front of the car and tap Start."}
                  </Text>
                </View>
                {recording ? (
                  <View style={styles.recBadge}>
                    <View style={styles.recDot} />
                    <Text style={styles.recText}>REC · {WALKAROUND_SECS - elapsed}s</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        )}

        <View style={styles.actions}>
          {phase === "walkaround-done" ? (
            <>
              <Btn label="Retake" onPress={() => { setVideoB64(null); setPhase("walkaround"); }} variant="secondary" testID="cap-video-retake" />
              <Btn label="Next: selfie →" onPress={() => setPhase("selfie")} testID="cap-video-next" />
            </>
          ) : !recording ? (
            <Btn
              label={cameraReady ? `Start · ${WALKAROUND_SECS}s` : "Preparing camera…"}
              onPress={startRecording}
              disabled={!cameraReady || !micPerm?.granted}
              testID="cap-video-start"
            />
          ) : (
            <Btn label="Stop" onPress={stopRecording} variant="danger" testID="cap-video-stop" />
          )}
        </View>

        {Platform.OS === "web" && phase === "walkaround" && !recording ? (
          <TouchableOpacity onPress={useWebPlaceholderVideo} style={styles.devSkip} testID="cap-video-web-placeholder">
            <Text style={styles.devSkipText}>Preview build — use placeholder video (dev only)</Text>
          </TouchableOpacity>
        ) : null}
        {err ? <Text style={styles.err} testID="cap-video-err">{err}</Text> : null}
      </SafeAreaView>
    );
  }

  if (phase === "selfie" || phase === "selfie-done") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={2} title="Selfie" />
        {phase === "selfie-done" && selfieB64 ? (
          <Image source={{ uri: selfieB64 }} style={styles.preview} />
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              key="cap-cam-selfie"
              ref={cameraRef}
              style={StyleSheet.absoluteFillObject}
              facing="front"
              mode="picture"
            />
            <View style={styles.reticle} pointerEvents="none">
              <Text style={styles.reticleText}>Frame your face in the circle</Text>
            </View>
          </View>
        )}
        <View style={styles.actions}>
          {phase === "selfie-done" ? (
            <>
              <Btn label="Retake" onPress={() => { setSelfieB64(null); setPhase("selfie"); }} variant="secondary" testID="cap-selfie-retake" />
              <Btn label="Review →" onPress={() => setPhase("review")} testID="cap-selfie-next" />
            </>
          ) : (
            <Btn label="Take selfie" onPress={takeSelfie} testID="cap-selfie-take" />
          )}
        </View>
        {err ? <Text style={styles.err}>{err}</Text> : null}
      </SafeAreaView>
    );
  }

  if (phase === "review" || phase === "submitting") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={3} title="Confirm & submit" />
        <View style={styles.reviewWrap}>
          <View style={styles.reviewCard}>
            <Text style={styles.reviewLabel}>Walk-around video</Text>
            <Text style={styles.reviewValue}>Captured ({WALKAROUND_SECS}s)</Text>
          </View>
          <View style={styles.reviewCard}>
            <Text style={styles.reviewLabel}>Selfie</Text>
            <Text style={styles.reviewValue}>Captured</Text>
          </View>
          <View style={styles.reviewCard}>
            <Text style={styles.reviewLabel}>Distance from hub</Text>
            <Text style={styles.reviewValue} testID="cap-review-hub-km">
              {distanceKm == null ? "unknown" : `${distanceKm.toFixed(1)} km`}
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Btn label="Back" onPress={() => setPhase("selfie-done")} variant="secondary" disabled={phase === "submitting"} testID="cap-review-back" />
          <Btn
            label={phase === "submitting" ? "Sending…" : "Submit & go online"}
            onPress={submit}
            disabled={phase === "submitting"}
            testID="cap-review-submit"
          />
        </View>
        {err ? <Text style={styles.err} testID="cap-review-err">{err}</Text> : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.doneWrap} testID="cap-done">
        <View style={styles.doneCircle}>
          <Text style={styles.doneTick}>✓</Text>
        </View>
        <Text style={styles.doneTitle}>Great — you can go online.</Text>
        <ActivityIndicator color={colors.live} style={{ marginTop: spacing.md }} />
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const fileToBase64 = async (uri: string): Promise<string> => {
  const res = await fetch(uri);
  const blob = await res.blob();
  const fr = new FileReader();
  return new Promise((resolve, reject) => {
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
};

const guessMime = (dataUrl: string): string => {
  const m = /^data:([^;]+);base64,/.exec(dataUrl);
  return m ? m[1] : "video/mp4";
};

const StepHeader: React.FC<{ step: 1 | 2 | 3; title: string }> = ({ step, title }) => (
  <View style={styles.stepHeader}>
    <Text style={styles.stepPill}>Step {step} / 3</Text>
    <Text style={styles.stepTitle}>{title}</Text>
  </View>
);

const Btn: React.FC<{
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  testID?: string;
}> = ({ label, onPress, variant = "primary", disabled, testID }) => {
  const bg = variant === "danger" ? colors.alert : variant === "secondary" ? colors.card : colors.live;
  const fg = variant === "secondary" ? colors.ink : colors.white;
  const border = variant === "secondary" ? colors.line : "transparent";
  return (
    <TouchableOpacity
      testID={testID}
      style={[styles.btn, { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.6 : 1 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.btnText, { color: fg }]}>{label}</Text>
    </TouchableOpacity>
  );
};

const Gate: React.FC<{ title: string; body: string; onGrant: () => void; testID?: string }> = ({
  title,
  body,
  onGrant,
  testID,
}) => (
  <View style={styles.gateWrap} testID={testID}>
    <Text style={styles.gateTitle}>{title}</Text>
    <Text style={styles.gateBody}>{body}</Text>
    <TouchableOpacity style={styles.gateBtn} onPress={onGrant}>
      <Text style={styles.gateBtnText}>Allow</Text>
    </TouchableOpacity>
  </View>
);

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  introWrap: { flex: 1, padding: spacing.xl, justifyContent: "center" },
  kicker: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.live,
    letterSpacing: 1.5,
    marginBottom: spacing.sm,
  },
  introTitle: { fontFamily: fonts.display, fontSize: 30, color: colors.ink, marginBottom: spacing.md },
  introBody: {
    fontFamily: fonts.ui,
    fontSize: 15,
    color: colors.muted,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  hubCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.line,
    marginBottom: spacing.lg,
  },
  hubLabel: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  hubValue: { fontFamily: fonts.dataMed, fontSize: 30, color: colors.ink, marginTop: 4 },
  hubHint: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 6 },
  stepHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  stepPill: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted, letterSpacing: 1 },
  stepTitle: { fontFamily: fonts.display, fontSize: 26, color: colors.ink, marginTop: 4 },
  cameraWrap: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.ink,
  },
  reticle: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "flex-end", padding: spacing.md },
  reticleText: {
    fontFamily: fonts.uiMed,
    fontSize: 12,
    color: colors.white,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
  stageBar: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    gap: 6,
    justifyContent: "space-between",
  },
  stageChip: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
  },
  stageChipActive: { backgroundColor: colors.live },
  stageChipDone: { backgroundColor: "rgba(11,122,75,0.55)" },
  stageChipText: { fontFamily: fonts.uiBold, fontSize: 11, color: "#EEF1EC" },
  stageChipTextActive: { color: colors.white },
  tipStrip: {
    position: "absolute",
    bottom: 90,
    left: spacing.md,
    right: spacing.md,
    alignItems: "center",
  },
  tipText: {
    fontFamily: fonts.uiBold,
    color: colors.white,
    fontSize: 14,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  recBadge: {
    position: "absolute",
    top: spacing.xxl + 8,
    right: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.alert },
  recText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.white },
  preview: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.ink,
  },
  videoDone: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  videoDoneIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.live,
    color: colors.white,
    fontFamily: fonts.uiBold,
    textAlign: "center",
    lineHeight: 64,
    fontSize: 28,
  },
  videoDoneText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.muted },
  reviewWrap: { padding: spacing.lg, gap: spacing.md, flex: 1 },
  reviewCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  reviewLabel: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  reviewValue: { fontFamily: fonts.dataMed, fontSize: 18, color: colors.ink, marginTop: 4 },
  actions: { flexDirection: "row", gap: spacing.md, padding: spacing.lg },
  btn: {
    flex: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
    borderWidth: 1,
  },
  btnText: { fontFamily: fonts.uiBold, fontSize: 15 },
  err: { fontFamily: fonts.uiMed, color: colors.alert, textAlign: "center", paddingHorizontal: spacing.lg },
  devSkip: {
    alignSelf: "center",
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  devSkipText: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    textDecorationLine: "underline",
  },
  gateWrap: { flex: 1, padding: spacing.xl, alignItems: "center", justifyContent: "center", gap: spacing.md },
  gateTitle: { fontFamily: fonts.display, fontSize: 22, color: colors.ink, textAlign: "center" },
  gateBody: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 20,
  },
  gateBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
  },
  gateBtnText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
  doneWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  doneCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.live,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  doneTick: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 44, lineHeight: 44 },
  doneTitle: { fontFamily: fonts.display, fontSize: 28, color: colors.ink },
});
