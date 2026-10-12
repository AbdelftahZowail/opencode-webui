/**
 * `question` tool body (parity R10) — a completed question renders a
 * `# Questions` block listing each question and its answer
 * (`routes/session/index.tsx:3475-3509`).
 *
 * Registered as the `tool.question` target. The tool input carries the
 * questions; the answers arrive either as structured tool metadata
 * (`answers`) or embedded in the tool's text output. Both are read here
 * defensively, and the raw output is shown when no structured answer exists so
 * a completed question is never blank.
 */

import { Fragment } from "react";
import type { ToolState } from "../api/types";
import { autoRegister } from "../extensions/registry";
import { Spinner } from "./ui";

interface QuestionBodyProps {
  state: ToolState;
  stateKey?: string;
  input: Record<string, unknown>;
  meta: Record<string, unknown>;
  output?: string;
  denied?: boolean;
}

interface QuestionLike {
  question?: string;
  header?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Questions from `input.questions` (array) or a single `input.question`. */
function questionsOf(input: Record<string, unknown>): QuestionLike[] {
  const list = input.questions;
  if (Array.isArray(list)) {
    return list.map((item) => {
      if (typeof item === "string") return { question: item };
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return { question: str(o.question), header: str(o.header) };
      }
      return {};
    });
  }
  const single = str(input.question);
  if (single) return [{ question: single }];
  return [];
}

function questionText(q: QuestionLike): string {
  return q.question ?? q.header ?? "";
}

/** Answers as one string-list per question, from metadata/input. */
function answersOf(
  meta: Record<string, unknown>,
  input: Record<string, unknown>,
  questions: QuestionLike[],
): string[][] {
  const raw = meta.answers ?? input.answers;
  const answers: string[][] = questions.map(() => []);
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => {
      if (i >= answers.length) return;
      answers[i] = toStringList(entry);
    });
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (/^\d+$/.test(key)) {
        const i = Number(key);
        if (i < answers.length) answers[i] = toStringList(value);
        continue;
      }
      const i = questions.findIndex((q) => questionText(q) === key);
      if (i >= 0) answers[i] = toStringList(value);
    }
  } else if (typeof raw === "string" && answers.length === 1) {
    answers[0] = [raw];
  }
  return answers;
}

function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

export function ToolQuestionBody(props: QuestionBodyProps) {
  const questions = questionsOf(props.input);
  const answers = answersOf(props.meta, props.input, questions);
  const settled = props.state.status === "completed" || props.state.status === "error";

  if (!settled) {
    return (
      <div className="py-0.5 pl-1 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-3 shrink-0 text-center font-mono text-[var(--text-weaker)]">?</span>
          <span className="flex items-center gap-2 text-[var(--text-base)]">
            <Spinner className="size-3" />
            <span className="font-medium">question</span>
            <span className="text-[var(--text-weaker)]">Asking…</span>
          </span>
        </div>
      </div>
    );
  }

  const hasStructured = answers.some((a) => a.length > 0);

  return (
    <div data-oc-tool-question className="my-1 overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-strong)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-1.5 text-xs text-[var(--text-weak)]">
        <span className="font-mono">#</span>
        <span className="font-medium text-[var(--text-base)]">Questions</span>
      </div>
      <div className="space-y-2 px-2.5 py-2">
        {questions.map((q, i) => {
          const answer = answers[i] ?? [];
          return (
            <div key={i} data-oc-question-row={i} className="text-xs">
              <div className="text-[var(--text-base)]">{questionText(q) || `Question ${i + 1}`}</div>
              <div className="mt-0.5 pl-3 text-[var(--text-weak)]">
                {answer.length > 0 ? (
                  answer.map((a, j) => (
                    <Fragment key={j}>
                      {j > 0 && <span className="text-[var(--text-weaker)]">, </span>}
                      <span>{a}</span>
                    </Fragment>
                  ))
                ) : (
                  <span className="text-[var(--text-weaker)]">(no answer)</span>
                )}
              </div>
            </div>
          );
        })}
        {!hasStructured && props.output && (
          <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-inset-base)] p-2 font-mono text-[10px] text-[var(--text-weak)]">
            {props.output}
          </pre>
        )}
        {questions.length === 0 && !props.output && (
          <p className="text-xs text-[var(--text-weaker)]">(no question details)</p>
        )}
      </div>
    </div>
  );
}

autoRegister({
  "tool.question": (p) => <ToolQuestionBody {...(p as unknown as QuestionBodyProps)} />,
});
