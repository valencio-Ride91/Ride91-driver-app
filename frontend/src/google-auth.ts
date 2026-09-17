// Emergent-managed Google sign-in helper.
//
// Two responsibilities:
//   1) openGoogleAuth() — kick off the WebBrowser session on mobile / a hard
//      redirect on web, and return the `session_id` that Emergent puts in the
//      callback URL. Reads from all three sources on Android to survive
//      Chrome Custom Tabs quirks.
//   2) exchangeSessionId(session_id) — POST it to our backend once and only
//      once, then return either the signed-in driver + token OR a link_token
//      that the UI walks through the phone+OTP step to bind the Google
//      account to a real fleet driver.
//
// The frontend never contacts Emergent's server directly — the backend
// exchanges the session_id.

import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

import { api } from "@/src/api";
import type { Driver } from "@/src/auth";

// Required so iOS finishes the auth session correctly and Android surfaces
// dismiss vs redirect properly.
WebBrowser.maybeCompleteAuthSession();

const AUTH_URL = "https://auth.emergentagent.com/?redirect=";

// Cache of session_ids we've already POSTed to the backend so a re-mount /
// hot deep link / cold start don't all try to redeem the same one.
const _consumed = new Set<string>();

function extractSessionId(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  // Emergent puts session_id in the hash fragment on some platforms and in
  // the query on others. Do a raw-string match so we cover both.
  const m = /[?#&]session_id=([^&#]+)/.exec(rawUrl);
  return m ? decodeURIComponent(m[1]) : null;
}

function redirectUrl(): string {
  if (Platform.OS === "web") {
    // Must point to an existing route.
    return `${window.location.origin}/login`;
  }
  return Linking.createURL("");
}

export async function openGoogleAuth(): Promise<string | null> {
  const redirect = redirectUrl();
  const url = `${AUTH_URL}${encodeURIComponent(redirect)}`;

  if (Platform.OS === "web") {
    // openAuthSessionAsync opens a cross-origin popup on web whose return URL
    // we can't read — hard redirect is the reliable path.
    window.location.href = url;
    return null;
  }

  // Register the linking listener BEFORE opening the browser — on Android
  // the OS may deliver the deep link before openAuthSessionAsync resolves.
  let capturedUrl: string | null = null;
  const sub = Linking.addEventListener("url", (event) => {
    if (!capturedUrl) capturedUrl = event.url;
  });

  try {
    const result = await WebBrowser.openAuthSessionAsync(url, redirect);
    // Prefer result.url; fall back to the deep-link listener and then to the
    // initial URL that woke the app.
    const candidate =
      (result as { url?: string }).url ??
      capturedUrl ??
      (await Linking.getInitialURL());
    return extractSessionId(candidate);
  } finally {
    sub.remove();
  }
}

// -----------------------------------------------------------------------
// Backend exchange
// -----------------------------------------------------------------------

export interface GoogleSessionResult {
  needs_link: false;
  token: string;
  driver: Driver;
}

export interface GoogleLinkNeeded {
  needs_link: true;
  link_token: string;
  google: { email: string; name?: string; picture?: string };
}

export type GoogleExchangeResult = GoogleSessionResult | GoogleLinkNeeded;

export async function exchangeSessionId(sessionId: string): Promise<GoogleExchangeResult | null> {
  if (_consumed.has(sessionId)) return null;
  _consumed.add(sessionId);
  return await api.post<GoogleExchangeResult>("/auth/session", { session_id: sessionId });
}

export interface GoogleLinkStartResult {
  otp_sent: boolean;
}

export async function googleLinkStart(link_token: string, phone: string): Promise<GoogleLinkStartResult> {
  return await api.post<GoogleLinkStartResult>("/auth/session/link/start", { link_token, phone });
}

export async function googleLinkVerify(
  link_token: string,
  phone: string,
  code: string,
  client_action_id: string,
): Promise<GoogleSessionResult> {
  return await api.post<GoogleSessionResult>("/auth/session/link/verify", {
    link_token,
    phone,
    code,
    client_action_id,
  });
}
