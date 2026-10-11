// Web Push, phone side. Subscribing needs a user gesture and, on iOS, an installed PWA (Add to Home Screen).
// The subscription goes to the Mac (behind the device token); the daemon sends the pushes itself.
import { api } from "./daemon.ts";

/** ios-install: iOS Safari in a tab (push only works from the Home Screen app) · unsupported · ok. */
export function pushSupport(): "ios-install" | "unsupported" | "ok" {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = (navigator as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  if (ios && !standalone) return "ios-install";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window ? "ok" : "unsupported";
}

export type PushState = "off" | "on" | "blocked";

const key = (b64url: string) => {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function register(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

async function upload(sub: PushSubscription): Promise<boolean> {
  const res = await fetch(api("/api/push/subscribe"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
  return res.ok;
}

/** What this phone is doing now. When notifications are on, re-sends the subscription so the Mac has it even after a restart or a re-pair. */
export async function pushState(): Promise<PushState> {
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  try {
    const sub = await (await register()).pushManager.getSubscription();
    if (!sub) return "off";
    await upload(sub);
    return "on";
  } catch {
    return "off";
  }
}

/** Call from a tap. Resolves to the new state, or throws a sentence. */
export async function enablePush(): Promise<PushState> {
  if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "blocked" : "off";
  const reg = await register();
  const res = await fetch(api("/api/push/key"), { cache: "no-store" });
  if (!res.ok) throw new Error("Couldn't reach your Mac.");
  const { publicKey } = (await res.json()) as { publicKey: string };
  let sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe(); // a stale one (older key) would be rejected by the push service
  sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(publicKey) });
  if (!(await upload(sub))) throw new Error("Your Mac didn't accept the subscription.");
  return "on";
}

export async function disablePush(): Promise<PushState> {
  try {
    const reg = await register();
    await fetch(api("/api/push/subscribe"), { method: "DELETE" });
    await (await reg.pushManager.getSubscription())?.unsubscribe();
  } catch {}
  return Notification.permission === "denied" ? "blocked" : "off";
}
