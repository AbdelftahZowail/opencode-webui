import { useState } from "react";
import { Archive, Download, EllipsisVertical, GitFork, Pencil } from "lucide-react";
import { compactSession, exportSession, forkSession, renameSession, selectSession, useStore } from "../store";
import type { SessionExportData } from "../api/client";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

type SessionDialog = "rename" | "fork" | "compact" | null;

export function SessionMenu({ sessionID }: { sessionID: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID));
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<SessionDialog>(null);

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" title="Session actions">
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => setDialog("rename")}>
            <Pencil /> Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("fork")}>
            <GitFork /> Fork…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void downloadTranscript(sessionID)}>
            <Download /> Export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog("compact")}>
            <Archive /> Compact
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "rename" && (
        <RenameDialog sessionID={sessionID} initialTitle={session?.title ?? ""} onClose={() => setDialog(null)} />
      )}
      {dialog === "fork" && <ForkDialog sessionID={sessionID} onClose={() => setDialog(null)} />}
      {dialog === "compact" && <CompactDialog sessionID={sessionID} onClose={() => setDialog(null)} />}
    </>
  );
}

function RenameDialog({ sessionID, initialTitle, onClose }: { sessionID: string; initialTitle: string; onClose: () => void }) {
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await renameSession(sessionID, trimmed);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Give this session a new title.</DialogDescription>
        </DialogHeader>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="Untitled session"
          autoFocus
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>Cancel</Button>
          </DialogClose>
          <Button onClick={() => void submit()} disabled={busy || !title.trim()}>Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ForkDialog({ sessionID, onClose }: { sessionID: string; onClose: () => void }) {
  const [boundary, setBoundary] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await forkSession(
        sessionID,
        boundary.trim() ? { type: "before", messageID: boundary.trim() } : { type: "through" },
      );
      await selectSession(id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fork session</DialogTitle>
          <DialogDescription>
            Copies the conversation into a new session. Leave the boundary empty to fork the full session.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={boundary}
          onChange={(e) => setBoundary(e.target.value)}
          placeholder="Boundary message ID (msg_…) — empty forks the full session"
          rows={3}
          autoFocus
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>Cancel</Button>
          </DialogClose>
          <Button onClick={() => void submit()} disabled={busy}>Fork</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompactDialog({ sessionID, onClose }: { sessionID: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await compactSession(sessionID, "steer");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compact session</DialogTitle>
          <DialogDescription>
            Summarizes the conversation so far into a single compact message so the agent can keep going with full context.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>Cancel</Button>
          </DialogClose>
          <Button onClick={() => void submit()} disabled={busy}>Compact</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Fetch a session transcript and trigger a markdown download. */
export async function downloadTranscript(sessionID: string) {
  try {
    const data = await exportSession(sessionID);
    const blob = new Blob([formatTranscript(data)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${sessionID.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("session export failed:", err);
  }
}

function formatTranscript(data: SessionExportData): string {
  const { info, messages } = data;
  const lines: string[] = [`# ${info.title || "Untitled session"}`, ""];
  lines.push(`Session \`${info.id}\` · exported ${new Date(info.time.created).toISOString()}`, "");
  for (const msg of messages) {
    if (msg.type === "assistant") {
      lines.push(`## assistant`, "");
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          lines.push(part.text, "");
        } else if (part.type === "reasoning" && part.text) {
          lines.push("```reasoning", part.text, "```", "");
        } else if (part.type === "tool") {
          lines.push(`> tool: \`${part.name}\` (\`${part.id}\`)`, "");
        }
      }
    } else if ("text" in msg && typeof msg.text === "string" && msg.text) {
      lines.push(`## ${msg.type}`, "", msg.text, "");
    } else if (msg.type === "shell") {
      lines.push(`## shell`, "", `> \`${msg.command}\``, "");
    }
  }
  return lines.join("\n");
}
