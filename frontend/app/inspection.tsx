// Pre-shift inspection: dashboard photo → exterior video (15s cap).
//
// Presented as its own route so the driver commits to it fully. Hard-gated:
// backend rejects duty/state with 409 inspection_required if not done for
// today. The client also checks status and routes here before switching to
// a working platform.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { useI18n } from "@/src/i18n";
import { api } from "@/src/api";

type Step = "dashboard" | "exterior" | "review" | "submitting" | "done";

const MAX_VIDEO_S = 15;

export default function Inspection() {
  const { t } = useI18n();
  const router = useRouter();
  const cameraRef = useRef<CameraView>(null);

  const [step, setStep] = useState<Step>("dashboard");
  const [facing, setFacing] = useState<CameraType>("back");
  const [dashPhotoUri, setDashPhotoUri] = useState<string | null>(null);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(MAX_VIDEO_S);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  // Auto-request permissions on mount.
  useEffect(() => {
    if (!camPerm?.granted && camPerm?.canAskAgain !== false) requestCamPerm();
    if (!micPerm?.granted && micPerm?.canAskAgain !== false) requestMicPerm();
  }, [camPerm?.granted, camPerm?.canAskAgain, micPerm?.granted, micPerm?.canAskAgain, requestCamPerm, requestMicPerm]);

  // Countdown timer while recording video.
  useEffect(() => {
    if (!recording) return;
    setCountdown(MAX_VIDEO_S);
    const id = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [recording]);

  const canUseCamera = camPerm?.granted;
  const canRecordVideo = camPerm?.granted && micPerm?.granted;

  const openSettings = useCallback(() => {
    // On both native and web we just re-request; if canAskAgain is false the
    // OS opens settings via requestCamPerm.
    requestCamPerm();
    requestMicPerm();
  }, [requestCamPerm, requestMicPerm]);

  // ---- Step 1: dashboard photo -------------------------------------------
  const takeDashboardPhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    setBusy(true);
    setErr(null);
    try {
      const shot = await cameraRef.current.takePictureAsync({
        quality: 0.55,
        base64: true,
        skipProcessing: false,
      });
      const uri = shot?.uri ?? null;
      const b64 = shot?.base64 ? `data:image/jpeg;base64,${shot.base64}` : null;
      setDashPhotoUri(b64 ?? uri);
    } catch (e: any) {
      setErr("Could not take photo. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  // ---- Step 2: exterior video --------------------------------------------
  const startRecording = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    setErr(null);
    setRecording(true);
    try {
      const v = await cameraRef.current.recordAsync({
        maxDuration: MAX_VIDEO_S,
      });
      if (v?.uri) {
        // Read file → base64 (native). On web, `v.uri` may be a blob URL that
        // we fetch and convert.
        const b64 = await fileToBase64(v.uri);
        setVideoUri(b64);
      }
    } catch (e: any) {
      setErr("Could not record video. Try again.");
    } finally {
      setRecording(false);
    }
  }, [recording]);

  const stopRecording = useCallback(() => {
    if (!cameraRef.current) return;
    try {
      cameraRef.current.stopRecording();
    } catch {
      // ignore
    }
  }, []);

  // ---- Submit -------------------------------------------------------------
  const submit = useCallback(async () => {
    if (!dashPhotoUri || !videoUri) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post("/inspection", {
        dashboard_photo_b64: dashPhotoUri,
        exterior_video_b64: videoUri,
        exterior_video_mime: guessMime(videoUri),
        client_action_id: Crypto.randomUUID(),
      });
      setStep("done");
      // Small delay so the driver sees the tick before we bounce back
      setTimeout(() => router.replace("/(tabs)"), 900);
    } catch (e: any) {
      setErr("Could not submit. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [dashPhotoUri, videoUri, router]);

  // ---- Render -------------------------------------------------------------
  if (!canUseCamera) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <PermissionGate
          title="Camera permission needed"
          body="To confirm the vehicle is fit for duty, we need to take one dashboard photo and one short walk-around video."
          onGrant={openSettings}
          testID="camera-perm-gate"
        />
      </SafeAreaView>
    );
  }

  if (step === "dashboard" && dashPhotoUri) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={1} title="Dashboard photo" />
        <Image source={{ uri: dashPhotoUri }} style={styles.preview} />
        <View style={styles.actions}>
          <Button
            label="Retake"
            onPress={() => setDashPhotoUri(null)}
            variant="secondary"
            testID="dash-retake"
          />
          <Button
            label="Looks good →"
            onPress={() => setStep("exterior")}
            testID="dash-confirm"
          />
        </View>
      </SafeAreaView>
    );
  }

  if (step === "dashboard") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={1} title="Dashboard photo" />
        <View style={styles.cameraWrap}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFillObject}
            facing={facing}
            mode="picture"
          />
          <View style={styles.reticle} pointerEvents="none">
            <Text style={styles.reticleText}>
              Frame the whole dashboard cluster
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Button
            label={facing === "back" ? "Front cam" : "Back cam"}
            onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))}
            variant="secondary"
            testID="dash-flip"
          />
          <Button
            label={busy ? "…" : "Capture"}
            onPress={takeDashboardPhoto}
            disabled={busy}
            testID="dash-capture"
          />
        </View>
        {err ? <Text style={styles.err}>{err}</Text> : null}
      </SafeAreaView>
    );
  }

  if (step === "exterior" && videoUri) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={2} title="Exterior video" />
        <View style={styles.videoDone} testID="video-done-block">
          <Text style={styles.videoDoneIcon}>✓</Text>
          <Text style={styles.videoDoneText}>Walk-around video captured</Text>
        </View>
        <View style={styles.actions}>
          <Button
            label="Retake"
            onPress={() => setVideoUri(null)}
            variant="secondary"
            testID="video-retake"
          />
          <Button
            label={busy ? "Sending…" : "Submit inspection"}
            onPress={submit}
            disabled={busy}
            testID="inspection-submit"
          />
        </View>
        {err ? <Text style={styles.err}>{err}</Text> : null}
      </SafeAreaView>
    );
  }

  if (step === "exterior") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <StepHeader step={2} title="Exterior video" />
        {!canRecordVideo ? (
          <PermissionGate
            title="Microphone permission needed"
            body="Video needs the mic so ops can hear the walk-around commentary."
            onGrant={openSettings}
            testID="mic-perm-gate"
          />
        ) : (
          <>
            <View style={styles.cameraWrap}>
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFillObject}
                facing="back"
                mode="video"
              />
              <View style={styles.reticle} pointerEvents="none">
                <Text style={styles.reticleText}>
                  Walk once around the car: front → right → back → left
                </Text>
              </View>
              {recording ? (
                <View style={styles.recBadge}>
                  <View style={styles.recDot} />
                  <Text style={styles.recText}>REC · {countdown}s</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.actions}>
              {!recording ? (
                <Button
                  label={`Start recording · ${MAX_VIDEO_S}s max`}
                  onPress={startRecording}
                  testID="video-start"
                />
              ) : (
                <Button
                  label="Stop"
                  onPress={stopRecording}
                  variant="danger"
                  testID="video-stop"
                />
              )}
            </View>
            {err ? <Text style={styles.err}>{err}</Text> : null}
          </>
        )}
      </SafeAreaView>
    );
  }

  if (step === "done") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.doneWrap} testID="inspection-done">
          <View style={styles.doneCircle}>
            <Text style={styles.doneTick}>✓</Text>
          </View>
          <Text style={styles.doneTitle}>All set.</Text>
          <Text style={styles.doneBody}>You can start your shift now.</Text>
          <ActivityIndicator color={colors.live} style={{ marginTop: spacing.md }} />
        </View>
      </SafeAreaView>
    );
  }

  return null;
}

// ---- helpers ---------------------------------------------------------------

const fileToBase64 = async (uri: string): Promise<string> => {
  if (Platform.OS === "web") {
    // uri is usually a blob:// URL — fetch and convert
    const res = await fetch(uri);
    const blob = await res.blob();
    const fr = new FileReader();
    return new Promise((resolve, reject) => {
      fr.onerror = () => reject(fr.error);
      fr.onload = () => resolve(String(fr.result));
      fr.readAsDataURL(blob);
    });
  }
  // Native: expo-file-system if installed, else fall back to fetch()
  try {
    const res = await fetch(uri);
    const blob = await res.blob();
    const fr = new FileReader();
    return await new Promise((resolve, reject) => {
      fr.onerror = () => reject(fr.error);
      fr.onload = () => resolve(String(fr.result));
      fr.readAsDataURL(blob);
    });
  } catch {
    return uri;
  }
};

const guessMime = (dataUrl: string): string => {
  const m = /^data:([^;]+);base64,/.exec(dataUrl);
  return m ? m[1] : "video/mp4";
};

const StepHeader: React.FC<{ step: 1 | 2; title: string }> = ({ step, title }) => (
  <View style={styles.stepHeader}>
    <Text style={styles.stepPill}>Step {step} / 2</Text>
    <Text style={styles.stepTitle} testID={`step-title-${step}`}>{title}</Text>
  </View>
);

const Button: React.FC<{
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
      style={[
        styles.btn,
        { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.6 : 1 },
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.btnText, { color: fg }]}>{label}</Text>
    </TouchableOpacity>
  );
};

const PermissionGate: React.FC<{
  title: string;
  body: string;
  onGrant: () => void;
  testID?: string;
}> = ({ title, body, onGrant, testID }) => (
  <View style={styles.gateWrap} testID={testID}>
    <Text style={styles.gateTitle}>{title}</Text>
    <Text style={styles.gateBody}>{body}</Text>
    <TouchableOpacity style={styles.gateBtn} onPress={onGrant} testID={`${testID}-grant`}>
      <Text style={styles.gateBtnText}>Allow</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  stepHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  stepPill: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 1,
  },
  stepTitle: { fontFamily: fonts.display, fontSize: 26, color: colors.ink, marginTop: 4 },
  cameraWrap: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.ink,
  },
  reticle: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "flex-end",
    padding: spacing.md,
  },
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
  recBadge: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
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
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  btn: {
    flex: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
    borderWidth: 1,
  },
  btnText: { fontFamily: fonts.uiBold, fontSize: 15 },
  err: {
    fontFamily: fonts.uiMed,
    color: colors.alert,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
  },
  gateWrap: {
    flex: 1,
    padding: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
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
  doneBody: { fontFamily: fonts.ui, fontSize: 14, color: colors.muted },
});
