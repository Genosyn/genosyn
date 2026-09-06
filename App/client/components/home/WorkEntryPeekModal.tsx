import React from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarClock } from "lucide-react";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button, buttonClassName } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { Company, WorkEntry } from "@/lib/api";
import { workClock, workEntryHref, workEntryLinkLabel, WORK_KIND_META } from "@/lib/workTimeline";

import { WorkEntryBlock } from "./WorkEntryViews";

/**
 * What one tile on the day chart actually was.
 *
 * A bar on a chart is a shape until you can ask it a question, and the answer
 * a reader wants is not the row's compact status token — it is the sentence:
 * who did this, to what, for how long, what it changed, how it ended. This is
 * where the chart pays off, so it says the whole thing rather than teasing a
 * page somewhere else.
 */
export function WorkEntryPeekModal({
  company,
  entry,
  nowIso,
  onClose,
  onOpenRun,
  onOpenEmployeeDay,
}: {
  company: Company;
  entry: WorkEntry;
  nowIso: string;
  onClose: () => void;
  /** Runs open the live log viewer Home already owns, not a second one. */
  onOpenRun: (entry: WorkEntry) => void;
  onOpenEmployeeDay: (employeeId: string) => void;
}) {
  const href = workEntryHref(entry, company.slug);
  const linkLabel = workEntryLinkLabel(entry);
  const at = new Date(entry.at);
  const absolute = Number.isNaN(at.getTime()) ? "" : at.toLocaleString();

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={entry.employee.name}
      description={
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span>{WORK_KIND_META[entry.kind].label}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={entry.at} title={absolute}>
            {workClock(entry.at) || absolute}
          </time>
        </span>
      }
      footer={
        <>
          <Button
            variant="secondary"
            type="button"
            onClick={() => onOpenEmployeeDay(entry.employee.id)}
          >
            <CalendarClock size={14} /> See the whole day
          </Button>
          {entry.kind === "run" && entry.run ? (
            <Button type="button" onClick={() => onOpenRun(entry)}>
              Open the run log
            </Button>
          ) : (
            href &&
            linkLabel && (
              <Link to={href} className={buttonClassName()} onClick={onClose}>
                {linkLabel} <ArrowUpRight size={14} />
              </Link>
            )
          )}
        </>
      }
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5">
          <Avatar
            name={entry.employee.name}
            kind="ai"
            size="md"
            src={employeeAvatarUrl(company.id, entry.employee.id, entry.employee.avatarKey)}
          />
        </span>
        <WorkEntryBlock entry={entry} nowIso={nowIso} />
      </div>
    </Modal>
  );
}
