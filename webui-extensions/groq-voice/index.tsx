/**
 * groq-voice — mic button next to Send in the composer (browser stratum ONLY).
 *
 * Click to record (getUserMedia +
 * MediaRecorder, best-supported mime first), click again to stop; audio goes
 * to Groq `whisper-large-v3-turbo` directly from the browser; the transcript
 * is space-joined onto the composer draft and the composer regains focus.
 *
 * v2 shape: ONE registry entry (kind "wrap", id "groq-voice") on the
 * `composer.sendActions` leaf target. Single-entry is deliberate, not lazy:
 * register() swaps same-id entries (one entry per id), and BOTH loaders
 * (webui-extensions/index.ts glob, src/lib/runtimeExtensions.ts) track folder
 * lifecycle by the single module `id` export — a second entry under another
 * id would survive disable/delete (settings/status residue, mic leak). So the
 * mic button, the transient status bubble, and the key settings dialog all
 * hang off this one wrap's tree. Do NOT add sibling entries with new ids.
 *
 * The API key lives in localStorage under `groq-voice.apiKey`
 * and is sent ONLY to api.groq.com.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Mic, Square } from "lucide-react";
import { getExtensionApi } from "../../src/lib/extensionApi";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export const id = "groq-voice";

// The ONE extension API surface — this shipped extension consumes it exactly
// like an external bundle would (via getExtensionApi), which keeps the
// surface honest.
const ext = getExtensionApi();

// ---------- constants ----------
const KEY_STORAGE = "groq-voice.apiKey";
const API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELS_URL = "https://api.groq.com/openai/v1/models";
const MODEL = "whisper-large-v3-turbo";
const MAX_RECORD_MS = 120000; // hard auto-stop after 2 minutes
const STATUS_MS = 6000; // transient status auto-clear
const DRAFTS_STORAGE = "webui.drafts"; // src/lib/drafts.ts — fallback path only

// ---------- API key storage ----------
function loadKey(): string {
  try {
    return window.localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function saveKey(key: string): void {
  try {
    if (key) window.localStorage.setItem(KEY_STORAGE, key);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode: ignore */
  }
}

// ---------- module-level status bus (button + bubble share it) ----------
interface VoiceStatus {
  kind: "error" | "working" | "ok";
  text: string;
}

const statusListeners = new Set<(status: VoiceStatus | null) => void>();
let currentStatus: VoiceStatus | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(status: VoiceStatus | null): void {
  currentStatus = status;
  for (const listener of Array.from(statusListeners)) {
    try {
      listener(status);
    } catch {
      /* listener error */
    }
  }
}

function subscribeStatus(fn: (status: VoiceStatus | null) => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

function getStatus(): VoiceStatus | null {
  return currentStatus;
}

function showTransient(status: VoiceStatus, ms: number = STATUS_MS): void {
  setStatus(status);
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    setStatus(null);
  }, ms);
}

function clearStatus(): void {
  if (statusTimer !== null) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  setStatus(null);
}

// ---------- helpers (full error taxonomy) ----------
function pickMimeType(): string | null {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (typeof window.MediaRecorder === "undefined") return null;
  for (const candidate of candidates) {
    try {
      if (window.MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* ignore */
  }
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError")
    return "Microphone permission denied — allow mic access in the browser and try again";
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "No microphone found — plug one in and try again";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "Microphone is busy or unreadable — close other apps using it and try again";
  return `Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`;
}

function transcriptionErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "missing-key") return "Groq API key missing — open the key settings (key button next to the mic)";
  if (msg === "empty-transcript") return "Groq returned an empty transcript — try speaking a little longer";
  const match = /^http (\d{3})/.exec(msg);
  if (match !== null) {
    switch (Number(match[1])) {
      case 401:
        return "Groq rejected the API key (401) — check it in the key settings";
      case 403:
        return "Groq denied access (403) — check the API key and account status";
      case 404:
        return "Groq endpoint not found (404) — the transcription API may have changed";
      case 413:
        return "Recording too large for Groq (413) — keep messages under ~25 MB";
      case 429:
        return "Groq rate limit hit (429) — wait a moment and try again";
      default: {
        const sep = msg.indexOf(": ");
        if (sep >= 0) return `Groq error: ${msg.slice(sep + 2)}`;
        return `Groq error (HTTP ${match[1]})`;
      }
    }
  }
  if (msg === "Failed to fetch" || msg.startsWith("NetworkError") || msg.startsWith("network"))
    return "Network error reaching Groq — check your connection";
  return `Transcription failed: ${msg}`;
}

// ---------- Groq API (direct from the browser — the key goes ONLY here) ----------
async function transcribe(blob: Blob, mimeType: string): Promise<string> {
  const key = loadKey().trim();
  if (key === "") throw new Error("missing-key");
  const form = new FormData();
  const fileExt = mimeType.includes("mp4") ? "m4a" : "webm";
  form.append("file", new File([blob], `voice-${Date.now()}.${fileExt}`, { type: mimeType || "audio/webm" }));
  form.append("model", MODEL);
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "network error");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { error?: { message?: unknown } };
      if (json?.error && typeof json.error.message === "string") detail = json.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail !== "" ? `http ${res.status}: ${detail}` : `http ${res.status}`);
  }
  const json = (await res.json()) as { text?: unknown };
  const text = typeof json.text === "string" ? json.text.trim() : "";
  if (text === "") throw new Error("empty-transcript");
  return text;
}

interface KeyTest {
  ok: boolean;
  status?: number;
  error?: string;
}

async function testKey(): Promise<KeyTest> {
  const key = loadKey().trim();
  if (key === "") return { ok: false, error: "missing-key" };
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true, status: res.status };
    let detail = "";
    try {
      const json = (await res.json()) as { error?: { message?: unknown } };
      if (json?.error && typeof json.error.message === "string") detail = json.error.message;
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, error: detail !== "" ? detail : `http ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- draft fallback (used ONLY when core predates the appendDraft prop) ----------
// The live path is the `appendDraft` rich prop on the `composer.sendActions`
// target (it flows into the composer's `text` state + refocus). This fallback
// merges into the localStorage draft map directly — the composer only picks
// it up on session switch, so it is strictly degraded.
function fallbackAppendDraft(sessionID: string, text: string): boolean {
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE);
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, { text: string; at: number }>;
    const prev = typeof map[sessionID]?.text === "string" ? (map[sessionID]?.text as string) : "";
    const base = prev.replace(/\s+$/, "");
    map[sessionID] = { text: base === "" ? text : `${base} ${text}`, at: Date.now() };
    window.localStorage.setItem(DRAFTS_STORAGE, JSON.stringify(map));
    const area = document.querySelector("[data-oc-composer-input]");
    if (area instanceof HTMLTextAreaElement) area.focus();
    return true;
  } catch {
    return false;
  }
}

// ---------- key settings dialog ----------
function GroqVoiceSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [key, setKey] = useState(loadKey);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<KeyTest | null>(null);

  // Fresh key + clean slate every time the dialog opens.
  useEffect(() => {
    if (open) {
      setKey(loadKey());
      setResult(null);
      setSaved(false);
    }
  }, [open ]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved ]);

  function onSave(): void {
    saveKey(key.trim());
    setSaved(true);
  }

  function onTest(): void {
    if (key.trim() === "") {
      setResult({ ok: false, error: "missing-key" });
      return;
    }
    setTesting(true);
    setResult(null);
    // Persist first so the live composer uses the tested key.
    saveKey(key.trim());
    void testKey().then((r) => {
      setTesting(false);
      setResult(r);
    });
  }

  let line: string;
  let lineClass = "text-[color:var(--text-weaker)]";
  if (result !== null) {
    if (result.ok) {
      line = `Key works — Groq accepted it (${result.status})`;
      lineClass = "text-green-600 dark:text-green-400";
    } else if (result.error === "missing-key") {
      line = "Enter a key first";
      lineClass = "text-red-600 dark:text-red-400";
    } else {
      line = `Key rejected: ${result.error ?? `http ${result.status}`}`;
      lineClass = "text-red-600 dark:text-red-400";
    }
  } else {
    line = "The key stays in this browser (localStorage) and is only ever sent to api.groq.com";
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Groq voice input</DialogTitle>
          <DialogDescription>
            The mic button in the chat composer records your voice and transcribes it with Groq{" "}
            {MODEL}. Get a free API key at console.groq.com (Keys).
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Groq API key</span>
          <Input
            type="password"
            value={key}
            placeholder="gsk_…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <div className={`min-h-5 text-xs ${lineClass}`} role="status">
          {line}
        </div>
        <DialogFooter>
          {saved && <span className="mr-auto self-center text-xs text-green-600 dark:text-green-400">Saved</span>}
          <Button type="button" variant="outline" size="sm" onClick={onSave}>
            Save
          </Button>
          <Button type="button" size="sm" disabled={testing || key.trim() === ""} onClick={onTest}>
            {testing ? "Testing…" : "Test key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- mic button cluster (mic + key settings + transient status) ----------
function GroqVoiceCluster({
  sessionID,
  appendDraft,
}: {
  sessionID: string;
  appendDraft?: (text: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatusState] = useState<VoiceStatus | null>(getStatus);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishingRef = useRef(false);
  const mountedRef = useRef(true);

  // Teardown on unmount (this fires on disable/delete/hot-swap): stop the
  // recorder, release the tracks, clear the timer + status. A disable
  // mid-recording must not leak the mic.
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeStatus(setStatusState);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const rec = recorderRef.current;
      if (rec && rec.state === "recording") {
        try {
          rec.onstop = null;
          rec.stop();
        } catch {
          /* already stopping */
        }
      }
      stopTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      clearStatus();
    };
  }, []);

  function teardown(): void {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    finishingRef.current = false;
  }

  function insertTranscript(text: string): boolean {
    if (appendDraft) {
      appendDraft(text);
      return true;
    }
    return fallbackAppendDraft(sessionID, text);
  }

  function startRecording(): void {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      showTransient({ kind: "error", text: "This browser does not support microphone recording" });
      return;
    }
    if (loadKey().trim() === "") {
      showTransient({
        kind: "error",
        text: "Groq API key missing — open the key settings (key button next to the mic)",
      });
      return;
    }
    setPhase("recording");
    let pending: Promise<MediaStream>;
    try {
      pending = navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setPhase("idle");
      showTransient({ kind: "error", text: micErrorMessage(err) });
      return;
    }
    void pending.then(
      (stream) => {
        if (!mountedRef.current || finishingRef.current) {
          stopTracks(stream);
          return;
        }
        streamRef.current = stream;
        const mime = pickMimeType();
        let recorder: MediaRecorder;
        try {
          recorder = mime !== null ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch {
          try {
            recorder = new MediaRecorder(stream);
          } catch {
            if (!mountedRef.current) {
              stopTracks(stream);
              return;
            }
            setPhase("idle");
            teardown();
            showTransient({ kind: "error", text: "This browser cannot record audio (MediaRecorder unavailable)" });
            return;
          }
        }
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onerror = () => {
          if (finishingRef.current || !mountedRef.current) return;
          setPhase("idle");
          teardown();
          showTransient({ kind: "error", text: "Recording failed — the microphone may be unavailable" });
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          const blobMime = recorder.mimeType || "audio/webm";
          const alive = mountedRef.current;
          teardown();
          if (blob.size === 0) {
            if (alive) {
              setPhase("idle");
              showTransient({ kind: "error", text: "Recording captured no audio — check the microphone and try again" });
            }
            return;
          }
          setStatus({ kind: "working", text: "Transcribing voice message…" });
          void transcribe(blob, blobMime).then(
            (text) => {
              const inserted = insertTranscript(text);
              if (alive) setPhase("idle");
              if (inserted) showTransient({ kind: "ok", text: "Transcribed and inserted" }, 4000);
              else showTransient({ kind: "error", text: "Transcribed, but could not insert it into the input" });
            },
            (err: unknown) => {
              if (alive) setPhase("idle");
              showTransient({ kind: "error", text: transcriptionErrorMessage(err) });
            },
          );
        };
        try {
          recorder.start();
          startedAtRef.current = Date.now();
          setElapsed(0);
          setStatus({ kind: "working", text: "Recording…" });
          timerRef.current = setInterval(() => {
            if (!mountedRef.current) return;
            const ms = Date.now() - startedAtRef.current;
            const secs = Math.round(ms / 1000);
            setElapsed(secs);
            setStatus({ kind: "working", text: `Recording… ${secs}s` });
            if (ms >= MAX_RECORD_MS) {
              showTransient(
                { kind: "working", text: "Reached the 2-minute recording limit — sending to Groq…" },
                4000,
              );
              stopRecordingRef.current();
            }
          }, 500);
        } catch {
          setPhase("idle");
          teardown();
          showTransient({ kind: "error", text: "Could not start recording" });
        }
      },
      (err: unknown) => {
        if (finishingRef.current || !mountedRef.current) return;
        setPhase("idle");
        teardown();
        showTransient({ kind: "error", text: micErrorMessage(err) });
      },
    );
  }

  function stopRecording(): void {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    finishingRef.current = true;
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPhase("transcribing");
    try {
      rec.stop(); // the onstop handler transcribes
    } catch {
      teardown();
      setPhase("idle");
      showTransient({ kind: "error", text: "Could not stop the recording" });
    }
  }

  // Stable ref so the interval reaches stopRecording without re-arming.
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;

  const label =
    phase === "recording" ? "Stop recording" : phase === "transcribing" ? "Transcribing…" : "Record a voice message";
  const title = phase === "recording" ? `Stop recording (${elapsed}s)` : label;

  return (
    <span className="relative mb-0.5 flex items-center" data-groq-voice>
      {phase === "recording" ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-groq-voice-mic="recording"
          aria-label={label}
          title={title}
          onMouseDown={(e) => e.preventDefault()} // keep composer focus (mirrors send button)
          onClick={() => stopRecordingRef.current()}
          className="animate-pulse tabular-nums"
        >
          <Square />
          {elapsed}s
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-groq-voice-mic="idle"
          aria-label={label}
          title={title}
          disabled={phase === "transcribing"}
          onMouseDown={(e) => e.preventDefault()} // keep composer focus (mirrors send button)
          onClick={startRecording}
        >
          {phase === "transcribing" ? <Loader2 className="animate-spin" /> : <Mic />}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-groq-voice-settings
        aria-label="Groq voice settings"
        title="Groq voice settings — API key"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setSettingsOpen(true)}
      >
        <KeyRound />
      </Button>
      {status !== null && (
        <span
          role="status"
          data-groq-voice-status=""
          title={status.text}
          className={`absolute right-0 bottom-full z-30 mb-2 w-max max-w-64 truncate rounded-md border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] px-2 py-1 text-xs shadow-lg ${
            status.kind === "error"
              ? "text-red-600 dark:text-red-400"
              : status.kind === "ok"
                ? "text-green-600 dark:text-green-400"
                : "text-[color:var(--text-weaker)]"
          }`}
        >
          {status.text}
        </span>
      )}
      <GroqVoiceSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </span>
  );
}

ext.register({
  kind: "wrap",
  id: "groq-voice",
  target: "composer.sendActions",
  render: (props, next) => {
    const sessionID = typeof props.sessionID === "string" ? props.sessionID : "";
    const rawAppend = props.appendDraft;
    const appendDraft =
      typeof rawAppend === "function" ? (rawAppend as (text: string) => void) : undefined;
    return (
      <>
        {next()}
        <GroqVoiceCluster sessionID={sessionID} appendDraft={appendDraft} />
      </>
    );
  },
});

// Self-accept so edits hot-swap: same-id registry swap, no reload.
if (import.meta.hot) import.meta.hot.accept();
