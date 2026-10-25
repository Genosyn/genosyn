import React from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  Library,
  MoreHorizontal,
  Pencil,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { api, type Resource } from "@/lib/api";
import {
  dataRoomsApi,
  documentIndexNumbers,
  jobFor,
  jobIsActive,
  type DataRoomDocument,
  type DataRoomFolder,
} from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { dataTransferHasFiles, filesFromDataTransfer } from "@/lib/fileDrop";
import {
  DATA_ROOM_ACCEPTED_EXTENSIONS,
  formatFileSize,
  isAcceptedDataRoomFile,
} from "../../../shared/dataRooms";
import type { RoomTabProps } from "../DataRoomDetail";
import { DocumentPreview } from "./DocumentPreview";
import { AiWorkBadge, plural } from "./shared";

type Upload = { key: string; name: string; error: string | null };

function DocumentIcon({ document }: { document: DataRoomDocument }) {
  const extension = document.filename.toLowerCase().split(".").pop() ?? "";
  const Icon =
    document.viewerKind === "image"
      ? ImageIcon
      : extension === "xlsx" || extension === "csv" || extension === "tsv"
        ? FileSpreadsheet
        : extension === "pptx"
          ? Presentation
          : FileText;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <Icon size={17} />
    </span>
  );
}

export function RoomDocumentsTab({ companyId, detail, reload }: RoomTabProps) {
  const dialog = useDialog();
  const roomsApi = dataRoomsApi(companyId);
  const { room, folders, documents, jobs } = detail;
  const [uploads, setUploads] = React.useState<Upload[]>([]);
  const [dragTarget, setDragTarget] = React.useState<string | null | undefined>(undefined);
  const [preview, setPreview] = React.useState<DataRoomDocument | null>(null);
  const [pickingResource, setPickingResource] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const fileInput = React.useRef<HTMLInputElement>(null);
  const uploadTarget = React.useRef<string | null>(null);
  const numbers = documentIndexNumbers(folders, documents);
  const folderByName = new Map(folders.map((folder) => [folder.name.trim().toLowerCase(), folder]));
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? documents.filter((document) =>
        `${document.title} ${document.filename} ${document.brief?.summary ?? ""}`
          .toLowerCase()
          .includes(needle),
      )
    : documents;
  // Readable documents with no brief and none on the way — say, briefs that
  // failed before the AI Employee had a model.
  const unbriefed = documents.filter(
    (document) =>
      document.textStatus === "extracted" &&
      !document.brief &&
      !jobIsActive(jobFor(jobs, "brief", document.id)),
  );

  async function uploadFiles(files: File[], folderId: string | null) {
    const accepted = files.filter((file) => isAcceptedDataRoomFile(file.name));
    const refused = files.filter((file) => !isAcceptedDataRoomFile(file.name));
    const batch = accepted.map((file) => ({
      key: `${file.name}-${Math.random()}`,
      name: file.name,
      error: null,
    }));
    setUploads((current) => [
      ...current,
      ...batch,
      ...refused.map((file) => ({
        key: `${file.name}-${Math.random()}`,
        name: file.name,
        error: "This type of file can't go in a data room.",
      })),
    ]);
    for (const [index, file] of accepted.entries()) {
      const key = batch[index].key;
      try {
        await roomsApi.upload(room.id, file, { folderId });
        setUploads((current) => current.filter((item) => item.key !== key));
      } catch (err) {
        setUploads((current) =>
          current.map((item) =>
            item.key === key ? { ...item, error: errorMessage(err, "Upload failed") } : item,
          ),
        );
      }
    }
    await reload();
  }

  function pickFiles(folderId: string | null) {
    uploadTarget.current = folderId;
    fileInput.current?.click();
  }

  function dropHandlers(folderId: string | null) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDragTarget(folderId);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragTarget(undefined);
      },
      onDrop: (event: React.DragEvent) => {
        const files = filesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        setDragTarget(undefined);
        void uploadFiles(files, folderId);
      },
    };
  }

  async function act(title: string, work: () => Promise<unknown>) {
    try {
      await work();
      await reload();
    } catch (err) {
      void dialog.error(err, { title });
    }
  }

  async function newFolder() {
    const name = await dialog.prompt({
      title: "New folder",
      placeholder: "Financials",
      confirmLabel: "Add folder",
    });
    if (!name?.trim()) return;
    await act("Couldn’t add the folder", () => roomsApi.createFolder(room.id, name.trim()));
  }

  async function renameFolder(folder: DataRoomFolder) {
    const name = await dialog.prompt({
      title: "Rename folder",
      defaultValue: folder.name,
      confirmLabel: "Rename",
    });
    if (!name?.trim() || name.trim() === folder.name) return;
    await act("Couldn’t rename the folder", () =>
      roomsApi.renameFolder(room.id, folder.id, name.trim()),
    );
  }

  async function moveFolder(folder: DataRoomFolder, delta: number) {
    const order = folders.map((item) => item.id);
    const from = order.indexOf(folder.id);
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    await act("Couldn’t reorder the folders", () => roomsApi.reorderFolders(room.id, order));
  }

  async function deleteFolder(folder: DataRoomFolder) {
    const count = documents.filter((document) => document.folderId === folder.id).length;
    const ok = await dialog.confirm({
      title: `Remove the folder "${folder.name}"?`,
      message: count
        ? `Its ${plural(count, "document")} move to the top of the room. Guests who were given only this folder lose access.`
        : "Guests who were given only this folder lose access.",
      confirmLabel: "Remove folder",
      variant: "danger",
    });
    if (ok)
      await act("Couldn’t remove the folder", () => roomsApi.deleteFolder(room.id, folder.id));
  }

  async function renameDocument(document: DataRoomDocument) {
    const title = await dialog.prompt({
      title: "Rename document",
      defaultValue: document.title,
      confirmLabel: "Rename",
    });
    if (!title?.trim() || title.trim() === document.title) return;
    await act("Couldn’t rename the document", () =>
      roomsApi.updateDocument(room.id, document.id, { title: title.trim() }),
    );
  }

  async function deleteDocument(document: DataRoomDocument) {
    const ok = await dialog.confirm({
      title: `Delete "${document.title}"?`,
      message: "Guests can no longer open it. Its activity stays in the room's record.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (ok)
      await act("Couldn’t delete the document", () =>
        roomsApi.deleteDocument(room.id, document.id),
      );
  }

  // Documents not yet in a folder lead, right under where they were dropped.
  const sections: Array<{ folder: DataRoomFolder | null; documents: DataRoomDocument[] }> = [
    { folder: null, documents: visible.filter((document) => !document.folderId) },
    ...folders.map((folder) => ({
      folder,
      documents: visible.filter((document) => document.folderId === folder.id),
    })),
  ];

  return (
    <div className="space-y-4" {...dropHandlers(null)}>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={DATA_ROOM_ACCEPTED_EXTENSIONS.join(",")}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void uploadFiles(files, uploadTarget.current);
        }}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block sm:w-72">
          <span className="sr-only">Search documents</span>
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles and briefs"
            className="w-full pl-8"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void newFolder()}>
            <FolderPlus size={14} /> New folder
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setPickingResource(true)}>
            <Library size={14} /> From Resources
          </Button>
          <Button size="sm" onClick={() => pickFiles(null)}>
            <UploadCloud size={14} /> Upload
          </Button>
        </div>
      </div>

      {room.aiEmployee && detail.aiModelConnected && unbriefed.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between dark:border-violet-500/25 dark:bg-violet-500/10">
          <span className="flex items-start gap-2 text-slate-700 dark:text-slate-200">
            <Sparkles size={15} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" />
            {plural(unbriefed.length, "document")} {unbriefed.length === 1 ? "has" : "have"} no
            brief yet.
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="self-start sm:self-auto"
            onClick={() =>
              void act("Couldn’t start the briefs", () => roomsApi.requestMissingBriefs(room.id))
            }
          >
            <Sparkles size={14} /> Ask {room.aiEmployee.name} to brief{" "}
            {unbriefed.length === 1 ? "it" : "them"}
          </Button>
        </div>
      )}

      {uploads.length > 0 && (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {uploads.map((upload) => (
            <div
              key={upload.key}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
            >
              <span className="min-w-0 truncate text-slate-800 dark:text-slate-200">
                {upload.name}
              </span>
              {upload.error ? (
                <span className="flex shrink-0 items-center gap-2 text-rose-700 dark:text-rose-300">
                  {upload.error}
                  <button
                    type="button"
                    className="text-xs font-medium underline"
                    onClick={() =>
                      setUploads((current) => current.filter((item) => item.key !== upload.key))
                    }
                  >
                    Dismiss
                  </button>
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Spinner size={14} /> Uploading
                </span>
              )}
            </div>
          ))}
        </Card>
      )}

      {documents.length === 0 && (
        <div
          className={clsx(
            "rounded-xl border border-dashed px-6 py-10 text-center",
            dragTarget === null
              ? "border-indigo-400 bg-indigo-50/60 dark:border-indigo-400 dark:bg-indigo-500/10"
              : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900/60",
          )}
        >
          <UploadCloud size={22} className="mx-auto text-slate-400" />
          <h3 className="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100">
            Drop documents here
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">
            PDF, Word, Excel, PowerPoint, text and image files up to 50 MB.{" "}
            {room.aiEmployee
              ? `${room.aiEmployee.name} briefs each one and files it in the right folder.`
              : "Drop them on a folder to file them there."}
          </p>
        </div>
      )}

      {sections.map(({ folder, documents: rows }) => {
        if (!folder && rows.length === 0 && documents.length > 0) return null;
        if (!folder && documents.length === 0) return null;
        const target = folder?.id ?? null;
        const dropping = dragTarget === target && dragTarget !== undefined;
        return (
          <Card
            key={folder?.id ?? "top"}
            className={clsx("overflow-hidden", dropping && "ring-2 ring-indigo-400")}
            {...dropHandlers(target)}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
              <div className="flex min-w-0 items-center gap-2">
                {folder && (
                  <span className="text-sm font-semibold tabular-nums text-slate-400 dark:text-slate-500">
                    {folder.number}
                  </span>
                )}
                <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {folder?.name ?? "Not in a folder"}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{rows.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => pickFiles(target)}
                  aria-label={`Upload to ${folder?.name ?? "the room"}`}
                >
                  <UploadCloud size={14} />
                  <span className="hidden sm:inline">Upload</span>
                </Button>
                {folder && (
                  <Menu
                    align="right"
                    width={200}
                    trigger={({ ref, onClick }) => (
                      <Button
                        ref={ref}
                        variant="ghost"
                        size="sm"
                        onClick={onClick}
                        aria-label={`Folder actions for ${folder.name}`}
                      >
                        <MoreHorizontal size={15} />
                      </Button>
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuItem
                          icon={<Pencil size={14} />}
                          label="Rename"
                          onSelect={() => {
                            close();
                            void renameFolder(folder);
                          }}
                        />
                        <MenuItem
                          icon={<ArrowUp size={14} />}
                          label="Move up"
                          onSelect={() => {
                            close();
                            void moveFolder(folder, -1);
                          }}
                        />
                        <MenuItem
                          icon={<ArrowDown size={14} />}
                          label="Move down"
                          onSelect={() => {
                            close();
                            void moveFolder(folder, 1);
                          }}
                        />
                        <MenuSeparator />
                        <MenuItem
                          icon={<Trash2 size={14} />}
                          label="Remove folder"
                          onSelect={() => {
                            close();
                            void deleteFolder(folder);
                          }}
                        />
                      </>
                    )}
                  </Menu>
                )}
              </div>
            </div>
            {rows.length === 0 ? (
              <div className="px-4 py-5 text-sm text-slate-500 dark:text-slate-400">
                {needle
                  ? "No matches here."
                  : "Empty — drop files here to file them in this folder."}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((document) => (
                  <DocumentRow
                    key={document.id}
                    document={document}
                    number={numbers.get(document.id) ?? ""}
                    folders={folders}
                    job={jobFor(jobs, "brief", document.id)}
                    suggested={
                      document.brief && document.brief.suggestedFolder
                        ? (folderByName.get(document.brief.suggestedFolder.trim().toLowerCase()) ??
                          null)
                        : null
                    }
                    onPreview={() => setPreview(document)}
                    onRename={() => void renameDocument(document)}
                    onDelete={() => void deleteDocument(document)}
                    onMove={(folderId) =>
                      void act("Couldn’t move the document", () =>
                        roomsApi.updateDocument(room.id, document.id, { folderId }),
                      )
                    }
                    onBrief={() =>
                      void act("Couldn’t brief the document", () =>
                        roomsApi.requestBrief(room.id, document.id),
                      )
                    }
                    downloadUrl={roomsApi.documentFileUrl(room.id, document.id, true)}
                    canBrief={Boolean(room.aiEmployee) && document.textStatus === "extracted"}
                  />
                ))}
              </ul>
            )}
          </Card>
        );
      })}

      <DocumentPreview
        companyId={companyId}
        roomId={room.id}
        document={preview}
        index={preview ? numbers.get(preview.id) : undefined}
        briefJob={preview ? jobFor(jobs, "brief", preview.id) : null}
        onClose={() => setPreview(null)}
      />
      <ResourcePicker
        open={pickingResource}
        onClose={() => setPickingResource(false)}
        companyId={companyId}
        folders={folders}
        onPick={async (resourceId, folderId) => {
          await roomsApi.fromResource(room.id, resourceId, folderId);
          await reload();
        }}
      />
    </div>
  );
}

function DocumentRow({
  document,
  number,
  folders,
  job,
  suggested,
  onPreview,
  onRename,
  onDelete,
  onMove,
  onBrief,
  downloadUrl,
  canBrief,
}: {
  document: DataRoomDocument;
  number: string;
  folders: DataRoomFolder[];
  job: ReturnType<typeof jobFor>;
  suggested: DataRoomFolder | null;
  onPreview: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMove: (folderId: string | null) => void;
  onBrief: () => void;
  downloadUrl: string;
  canBrief: boolean;
}) {
  const cautions = document.brief?.cautions ?? [];
  const suggestMove = suggested && suggested.id !== document.folderId;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <DocumentIcon document={document} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {number && (
            <span className="text-xs font-medium tabular-nums text-slate-400 dark:text-slate-500">
              {number}
            </span>
          )}
          <button
            type="button"
            onClick={onPreview}
            className="min-w-0 truncate text-left text-sm font-medium text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-slate-100"
          >
            {document.title}
          </button>
          <AiWorkBadge job={job} working="Briefing…" />
          {cautions.length > 0 && (
            <Badge tone="warning" icon={<AlertTriangle />} title={cautions.join("\n")}>
              {plural(cautions.length, "thing")} to check
            </Badge>
          )}
          {document.textStatus === "none" && (
            <Badge title="Scans and images have no text for the AI Employee to read">No text</Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
          {document.filename} · {formatFileSize(document.sizeBytes)}
          {document.pageCount
            ? ` · ${plural(document.pageCount, document.filename.toLowerCase().endsWith(".pptx") ? "slide" : "page")}`
            : ""}
        </div>
        {document.brief && (
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {document.brief.summary}
          </p>
        )}
        {suggestMove && (
          <button
            type="button"
            onClick={() => onMove(suggested.id)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
          >
            <Sparkles size={12} /> Belongs in {suggested.number} {suggested.name} — move it
          </button>
        )}
      </div>
      <Menu
        align="right"
        width={240}
        trigger={({ ref, onClick }) => (
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            onClick={onClick}
            aria-label={`Actions for ${document.title}`}
          >
            <MoreHorizontal size={15} />
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<Eye size={14} />}
              label="Preview"
              onSelect={() => {
                close();
                onPreview();
              }}
            />
            <MenuItem
              icon={<Pencil size={14} />}
              label="Rename"
              onSelect={() => {
                close();
                onRename();
              }}
            />
            <MenuItem
              icon={<Download size={14} />}
              label="Download"
              onSelect={() => {
                close();
                window.location.assign(downloadUrl);
              }}
            />
            {canBrief && (
              <MenuItem
                icon={<RefreshCw size={14} />}
                label="Brief again"
                onSelect={() => {
                  close();
                  onBrief();
                }}
              />
            )}
            <MenuSeparator />
            <MenuHeader>Move to</MenuHeader>
            {folders
              .filter((folder) => folder.id !== document.folderId)
              .map((folder) => (
                <MenuItem
                  key={folder.id}
                  icon={<FolderInput size={14} />}
                  label={`${folder.number} ${folder.name}`}
                  onSelect={() => {
                    close();
                    onMove(folder.id);
                  }}
                />
              ))}
            {document.folderId && (
              <MenuItem
                icon={<FolderInput size={14} />}
                label="Out of its folder"
                onSelect={() => {
                  close();
                  onMove(null);
                }}
              />
            )}
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={14} />}
              label="Delete"
              onSelect={() => {
                close();
                onDelete();
              }}
            />
          </>
        )}
      </Menu>
    </li>
  );
}

function ResourcePicker({
  open,
  onClose,
  companyId,
  folders,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  folders: DataRoomFolder[];
  onPick: (resourceId: string, folderId: string | null) => Promise<void>;
}) {
  const [resources, setResources] = React.useState<Resource[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [folderId, setFolderId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setSelected(null);
    setError(null);
    setQuery("");
    api
      .get<Resource[]>(`/api/companies/${companyId}/resources`)
      .then(setResources)
      .catch((err: unknown) => {
        setResources([]);
        setError(errorMessage(err, "Could not load Resources"));
      });
  }, [open, companyId]);

  const visible = (resources ?? []).filter((resource) =>
    query.trim() ? resource.title.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) {
      setError("Choose a Resource.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onPick(selected, folderId || null);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not add the Resource"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add from Resources"
      description="The room keeps its own copy. Changing the Resource later changes nothing guests see."
      onSubmit={submit}
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <Library size={14} /> Add to room
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Resources"
          className="w-full"
        />
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
          {resources === null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner />
            </div>
          ) : visible.length === 0 ? (
            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">No Resources match.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((resource) => (
                <li key={resource.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(resource.id)}
                    aria-pressed={selected === resource.id}
                    className={clsx(
                      "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm",
                      selected === resource.id
                        ? "bg-indigo-50 dark:bg-indigo-500/15"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
                    )}
                  >
                    <span className="min-w-0 truncate text-slate-900 dark:text-slate-100">
                      {resource.title}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                      {resource.sourceFilename ?? resource.sourceKind}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Folder</span>
          <Select
            className="mt-1 w-full"
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">Let the AI Employee file it</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.number} {folder.name}
              </option>
            ))}
          </Select>
        </label>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
