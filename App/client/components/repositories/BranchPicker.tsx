import React from "react";
import { ChevronDown, FilePlus2, GitBranch } from "lucide-react";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../ui/Menu";
import { RepositoryBranch, RepositoryStatus } from "../../lib/api";

/**
 * The control that says which branch the App-owned checkout is on, and moves
 * it somewhere else.
 *
 * It lives here rather than on the Files page because History shows the commits
 * of whatever branch is checked out, and reading another branch's history used
 * to mean going to Files, switching, and coming back. One checkout, one
 * control, two pages.
 */

/** How many remote-only branches to offer before the menu becomes a list. */
const MAX_REMOTE_BRANCHES = 20;

export function branchLabelFor(
  status: RepositoryStatus | null,
  defaultBranch: string,
): { label: string; title: string } {
  if (status?.detached) {
    return {
      label: "Not on a branch",
      title:
        "This checkout is parked on a single commit rather than a branch. Pick a branch here to carry on.",
    };
  }
  const label = status?.branch ?? defaultBranch;
  return { label, title: `On ${label}` };
}

export function BranchPicker({
  status,
  branches,
  defaultBranch,
  disabled = false,
  onCheckout,
  onCreateBranch,
}: {
  status: RepositoryStatus | null;
  branches: RepositoryBranch[];
  /** Shown before the first status has arrived, so the control is never blank. */
  defaultBranch: string;
  disabled?: boolean;
  onCheckout: (name: string) => void;
  /** Omitted where creating a branch would be beside the point. */
  onCreateBranch?: () => void;
}) {
  const local = branches.filter((branch) => !branch.remote);
  const localNames = new Set(local.map((branch) => branch.name));
  // A remote branch is listed as `origin/x`, but checkout expects the bare
  // name — and once a local `x` exists the remote row is just a duplicate.
  const remote = branches
    .filter((branch) => branch.remote)
    .map((branch) => ({ ...branch, bare: branch.name.replace(/^origin\//, "") }))
    .filter((branch) => !localNames.has(branch.bare));
  const { label, title } = branchLabelFor(status, defaultBranch);

  return (
    <Menu
      align="left"
      width={300}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          disabled={disabled}
          title={title}
          className="inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          aria-label="Switch branch"
        >
          <GitBranch size={14} className="shrink-0 text-slate-400" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
          <ChevronDown
            size={13}
            className={"shrink-0 text-slate-400 " + (open ? "rotate-180" : "")}
          />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>This repository</MenuHeader>
          {local.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500">
              No branches yet — the first commit creates one.
            </div>
          )}
          {local.map((branch) => (
            <MenuItem
              key={branch.name}
              active={branch.current}
              icon={<GitBranch size={13} />}
              label={<span className="font-mono text-xs">{branch.name}</span>}
              onSelect={() => {
                close();
                if (!branch.current) onCheckout(branch.name);
              }}
            />
          ))}
          {remote.length > 0 && (
            <>
              <MenuSeparator />
              <MenuHeader>On the remote</MenuHeader>
              {remote.slice(0, MAX_REMOTE_BRANCHES).map((branch) => (
                <MenuItem
                  key={branch.name}
                  icon={<GitBranch size={13} />}
                  label={<span className="font-mono text-xs">{branch.bare}</span>}
                  hint="track"
                  onSelect={() => {
                    close();
                    onCheckout(branch.bare);
                  }}
                />
              ))}
            </>
          )}
          {onCreateBranch && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<FilePlus2 size={13} />}
                label="New branch…"
                onSelect={() => {
                  close();
                  onCreateBranch();
                }}
              />
            </>
          )}
        </>
      )}
    </Menu>
  );
}
