import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import type { QuestionAnswer, QuestionRequest } from "../api/types";
import { rejectQuestion, replyQuestion, useStore } from "../store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export function QuestionModal() {
  const currentID = useStore((s) => s.currentSessionID);
  const questions = useStore((s) => s.questions);
  const mine = questions.filter((q) => q.sessionID === currentID);

  if (mine.length === 0) return null;
  const req = mine[0]!;

  return <QuestionDialog key={req.id} req={req} queued={mine.length - 1} />;
}

function QuestionDialog({ req, queued }: { req: QuestionRequest; queued: number }) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<QuestionAnswer[]>(() => req.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => req.questions.map(() => ""));

  const toggle = (qi: number, label: string) => {
    const multiple = req.questions[qi]?.multiple;
    setSelected((prev) => {
      const next = prev.map((a, i) => (i === qi ? [...a] : a));
      const cur = next[qi]!;
      if (cur.includes(label)) {
        next[qi] = cur.filter((l) => l !== label);
      } else {
        next[qi] = multiple ? [...cur, label] : [label];
      }
      return next;
    });
  };

  const buildAnswers = (): QuestionAnswer[] =>
    req.questions.map((q, i) => {
      const answers = [...selected[i]!];
      if (q.custom && custom[i]!.trim()) answers.push(custom[i]!.trim());
      return answers;
    });

  const complete = req.questions.every(
    (q, i) => selected[i]!.length > 0 || (q.custom && custom[i]!.trim().length > 0),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) void rejectQuestion(req.id);
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Question
              <Badge variant="outline" className="border-[var(--border-weak-base)] font-mono text-[var(--text-interactive-base)]">
                {req.sessionID}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          {req.tool && (
            <DialogDescription>
              Asked by tool <span className="font-mono text-[var(--text-strong)]">{req.tool.id}</span>
            </DialogDescription>
          )}
          <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
            {req.questions.map((q, qi) => (
              <div key={qi} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-[var(--text-weak)]">{q.header}</span>
                  {q.multiple && (
                    <Badge variant="outline" className="border-[var(--border-weak-base)] text-[var(--text-weak)]">
                      multiple
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-[var(--text-strong)]">{q.question}</p>
                {q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt) => {
                      const active = selected[qi]!.includes(opt.label);
                      return (
                        <Button
                          key={opt.label}
                          type="button"
                          variant={active ? "default" : "secondary"}
                          size="sm"
                          title={opt.description}
                          onClick={() => toggle(qi, opt.label)}
                        >
                          {opt.label}
                        </Button>
                      );
                    })}
                  </div>
                )}
                {q.custom && (
                  <Textarea
                    value={custom[qi]}
                    onChange={(e) => setCustom((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
                    placeholder="Custom answer"
                    className="min-h-16 font-mono text-xs"
                  />
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-[var(--text-weaker)]">More questions are queued behind this one: {queued}</p>
          <DialogFooter className="rounded-b-lg">
            <Button variant="destructive" onClick={() => void rejectQuestion(req.id)}>
              Reject
            </Button>
            <Button disabled={!complete} onClick={() => void replyQuestion(req.id, buildAnswers())}>
              Reply
            </Button>
          </DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
