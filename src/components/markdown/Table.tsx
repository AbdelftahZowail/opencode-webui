/**
 * Markdown table — a first-class core grid.
 *
 * Deliberately a ReactMarkdown `components` mapping rather than broad CSS on
 * the message class list: the wrapper is an element core owns, so wide tables
 * scroll horizontally INSIDE their own bordered container without the table's
 * intrinsic width ever pushing the transcript wide (no `display:block` on the
 * table itself, no `max-w-full` tricks).
 *
 * Design:
 *  - outer wrapper: rounded frame + horizontal scroll + vertical containment
 *  - the table is `w-max min-w-full` so short tables fill the column and wide
 *    ones keep their natural width and scroll
 *  - header row on the raised surface token, medium weight, strong text
 *  - zebra striping + hover from the base surface tokens
 *  - GFM `text-align` is honored (react-markdown emits `style="text-align:…"`
 *    on aligned cells; horizontal padding rides the same axis via CSS logical
 *    values on `th`/`td` so alignment is not beaten by padding)
 *
 * All colors are design tokens, so light/dark stay native.
 */
import type { ComponentPropsWithoutRef } from "react";

const TH_CLS =
  "border border-[var(--border-base)] border-b-[1.5px] border-b-[var(--border-active)] bg-[var(--surface-raised-base)] px-3 py-1.5 align-top font-medium text-[var(--text-strong)]";

/** Body cell: GFM alignment rides on the inline `text-align` react-markdown
 *  emits; `break-words` + `overflow-wrap:anywhere` keep long unbroken tokens
 *  contained instead of widening the grid. Padding stays in `px-3` (physical)
 *  so it never competes with the inline text-align on the same axis. */
const TD_CLS =
  "border border-[var(--border-base)] px-3 py-1.5 align-top break-words text-[var(--text-base)] [overflow-wrap:anywhere]";

export function Table({ children, ...rest }: ComponentPropsWithoutRef<"table">) {
  return (
    <div
      data-oc-table
      className="my-3 max-w-full min-w-0 overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]"
    >
      <div className="max-w-full overflow-x-auto">
        <table
          {...rest}
          className="w-max min-w-full border-collapse text-sm [&_tbody_tr:nth-child(even)]:bg-[color:var(--surface-base)] [&_tbody_tr:hover]:bg-[color:var(--surface-base-hover)]"
        >
          {children}
        </table>
      </div>
    </div>
  );
}

export function Th({ children, ...rest }: ComponentPropsWithoutRef<"th">) {
  return (
    <th {...rest} className={TH_CLS}>
      {children}
    </th>
  );
}

export function Td({ children, ...rest }: ComponentPropsWithoutRef<"td">) {
  return (
    <td {...rest} className={TD_CLS}>
      {children}
    </td>
  );
}
