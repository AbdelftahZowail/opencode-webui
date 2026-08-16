import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Sparkles, Terminal } from "lucide-react";
import { api } from "../api/client";
import type { FsEntry, PromptFile } from "../api/client";
import type { CommandInfo, SkillInfo } from "../api/types";
import { activateSkill, sendCommand, sendPrompt, sendPromptWithFiles, sendShell, useStore } from "../store";
import { FilePicker } from "./FilePicker";
import { Spinner } from "./ui";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

export function Composer({ sessionID }: { sessionID: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [pickedFiles, setPickedFiles] = useState<{ path: string; content?: string }[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const running = useStore((s) => s.running[sessionID] ?? false);
  const queued = useStore((s) => !!s.queued[sessionID]);
  const sessionLocation = useStore((s) => s.sessions.find((x) => x.id === sessionID)?.location?.directory);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void api.commands().then(setCommands);
    void api.skills().then(setSkills);
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const isSlash = text.startsWith("/") && !text.includes(" ");
  const filteredCommands = commands.filter((c) => c.name.startsWith(filter));
  const filteredSkills = skills.filter((s) => (s.description ?? "").toLowerCase().includes(filter.toLowerCase()));

  const mentionQuery = useMemo(() => {
    const idx = text.lastIndexOf("@");
    if (idx === -1) return undefined;
    const before = idx === 0 ? "" : text[idx - 1]!;
    const after = text.slice(idx + 1);
    if ((idx === 0 || /\s/.test(before)) && !/\s/.test(after)) return after;
    return undefined;
  }, [text]);

  useEffect(() => {
    setMentionDismissed(false);
  }, [text]);

  function handleFilePick(entry: FsEntry) {
    const idx = text.lastIndexOf("@");
    if (idx === -1) return;
    const token = `@${entry.path}`;
    setText(text.slice(0, idx) + token + " ");
    setPickedFiles((prev) => [...prev, { path: entry.path }]);
    if (sessionLocation) {
      void api
        .fsRead(entry.path, sessionLocation)
        .then((content) =>
          setPickedFiles((prev) => prev.map((f) => (f.path === entry.path ? { path: f.path, content } : f))),
        )
        .catch(() => undefined);
    }
    textareaRef.current?.focus();
  }

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (value.startsWith("!")) {
        await sendShell(value.slice(1));
      } else if (value.startsWith("/")) {
        const parts = value.slice(1).split(" ");
        await sendCommand(parts[0]!, parts.slice(1).join(" ") || undefined);
      } else if (pickedFiles.length > 0) {
        const files: PromptFile[] = [];
        for (const picked of pickedFiles) {
          if (!sessionLocation) continue;
          const token = `@${picked.path}`;
          const idx = value.indexOf(token);
          files.push({
            uri: `file://${encodeURI(`${sessionLocation.replace(/\/+$/, "")}/${picked.path}`)}`,
            name: picked.path,
            mention: idx !== -1 ? { start: idx, end: idx + token.length, text: token } : undefined,
          });
        }
        if (files.length > 0) {
          await sendPromptWithFiles(value, files);
        } else {
          await sendPrompt(value);
        }
      } else {
        await sendPrompt(value);
      }
      setText("");
      setPickedFiles([]);
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  }

  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-2.5 pt-2">
      <div className="mx-auto max-w-3xl">
        <Popover open={isSlash}>
          <PopoverAnchor asChild>
            <div className="rounded-lg border border-[color:var(--border-base)] bg-[color:var(--input-base)] p-2 transition-colors focus-within:border-[color:var(--border-selected)]">
              <FilePicker
                open={mentionQuery !== undefined && !mentionDismissed}
                query={mentionQuery ?? ""}
                location={sessionLocation}
                onOpenChange={setMentionDismissed}
                onPick={handleFilePick}
              >
                <div className="flex items-end gap-2">
                  <Textarea
                    id="composer-input"
                    ref={textareaRef}
                    value={text}
                    placeholder={
                      running
                        ? "Agent is working… (press Enter to queue)"
                        : queued
                          ? "Waiting for the agent… (press Enter to queue more)"
                          : "Message the agent…  (/ for commands)"
                    }
                    className="max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-1 text-sm placeholder:text-[color:var(--text-weaker)] focus-visible:ring-0"
                    onChange={(e) => {
                      setText(e.target.value);
                      setFilter(e.target.value.slice(1));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  {busy ? (
                    <Spinner className="mb-1.5 mr-2" />
                  ) : (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={!text.trim() || running}
                      onClick={() => void submit()}
                      title="Send (Enter)"
                    >
                      <Send />
                      Send
                    </Button>
                  )}
                </div>
              </FilePicker>
            </div>
          </PopoverAnchor>
          <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(26rem,calc(100vw-2rem))] p-0">
            <Command>
              <CommandList>
                {filteredCommands.length > 0 && (
                  <CommandGroup heading="Commands">
                    {filteredCommands.map((c) => (
                      <CommandItem
                        key={c.name}
                        onSelect={() => {
                          setText(`/${c.name} `);
                          textareaRef.current?.focus();
                        }}
                      >
                        <Terminal className="text-[color:var(--text-weak)]" />
                        <span className="font-mono text-[color:var(--text-interactive-base)]">/{c.name}</span>
                        {c.description && (
                          <span className="ml-auto max-w-[55%] truncate pl-3 text-xs text-[color:var(--text-weaker)]">
                            {c.description}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {filteredCommands.length > 0 && filteredSkills.length > 0 && <CommandSeparator />}
                {filteredSkills.length > 0 && (
                  <CommandGroup heading="Skills">
                    {filteredSkills.map((s) => (
                      <CommandItem key={s.id} onSelect={() => void activateSkill(s.id)}>
                        <Sparkles className="text-[color:var(--surface-brand-base)]" />
                        <span className="text-[color:var(--surface-brand-base)]">{s.name}</span>
                        {s.description && (
                          <span className="ml-auto max-w-[55%] truncate pl-3 text-xs text-[color:var(--text-weaker)]">
                            {s.description}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {filteredCommands.length === 0 && filteredSkills.length === 0 && (
                  <CommandEmpty>No matching commands or skills</CommandEmpty>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <div className="mt-2 flex items-center justify-between px-1 text-xs text-[color:var(--text-weaker)]">
          <p>
            Ask anything, <span className="font-medium text-[color:var(--text-weak)]">/</span> for commands,{" "}
            <span className="font-medium text-[color:var(--text-weak)]">@</span> for files,{" "}
            <span className="font-medium text-[color:var(--text-weak)]">!</span> for bash
          </p>
          <p className="hidden sm:block">Enter to send · Shift+Enter for newline</p>
        </div>
      </div>
    </div>
  );
}
