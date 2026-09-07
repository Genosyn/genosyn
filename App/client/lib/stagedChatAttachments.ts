import React from "react";
import type { ChatAttachment } from "./api";

export const CHAT_ATTACHMENT_MAX_COUNT = 10;
export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export type StagedChatAttachment = ChatAttachment & { previewUrl?: string };

/** Pure validation also used before a batch reserves its upload slots. */
export function attachmentUploadError(file: Pick<File, "size" | "name">): string | null {
  if (file.size === 0) return `${file.name}: the file is empty.`;
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) return `${file.name}: files must be 25 MB or smaller.`;
  return null;
}

/** Uploads belong to the draft that started them, even after navigation. */
export function useChatAttachments({
  scopeKey,
  upload,
  onError,
  maxCount = CHAT_ATTACHMENT_MAX_COUNT,
}: {
  scopeKey: string;
  upload: (file: File) => Promise<ChatAttachment>;
  onError: (message: string) => void;
  maxCount?: number;
}) {
  const [pending, setPending] = React.useState<StagedChatAttachment[]>([]);
  const [uploading, setUploading] = React.useState(0);
  const state = React.useRef({
    scopeKey,
    generation: 0,
    count: 0,
    uploading: 0,
    urls: new Set<string>(),
    staged: new Map<string, StagedChatAttachment>(),
    active: true,
  });
  const latest = React.useRef({ upload, onError });
  latest.current = { upload, onError };
  // Invalidate synchronously: an old upload may finish before effects run.
  if (state.current.scopeKey !== scopeKey) {
    state.current.scopeKey = scopeKey;
    state.current.generation += 1;
    state.current.count = 0;
    state.current.uploading = 0;
    state.current.staged.clear();
  }
  const releaseUrls = React.useCallback(() => {
    for (const url of state.current.urls) URL.revokeObjectURL(url);
    state.current.urls.clear();
  }, []);
  React.useEffect(() => {
    releaseUrls();
    setPending([]);
    setUploading(0);
  }, [scopeKey, releaseUrls]);
  React.useEffect(() => {
    const current = state.current;
    current.active = true;
    return () => {
      current.active = false;
      current.generation += 1;
      releaseUrls();
    };
  }, [releaseUrls]);

  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const current = state.current;
      const generation = current.generation;
      const batch: File[] = [];
      for (const file of Array.from(files)) {
        const error = attachmentUploadError(file);
        if (error) {
          latest.current.onError(error);
          continue;
        }
        if (current.count >= maxCount) {
          latest.current.onError(`Attach at most ${maxCount} files to one message.`);
          break;
        }
        current.count += 1;
        current.uploading += 1;
        batch.push(file);
      }
      setUploading(current.uploading);
      const uploadFile = latest.current.upload;
      void (async () => {
        for (const file of batch) {
          if (!current.active || current.generation !== generation) return;
          try {
            const attachment = await uploadFile(file);
            if (!current.active || current.generation !== generation) return;
            const previewUrl = file.type.startsWith("image/")
              ? URL.createObjectURL(file)
              : undefined;
            if (previewUrl) current.urls.add(previewUrl);
            const staged = { ...attachment, previewUrl };
            current.staged.set(staged.id, staged);
            setPending((previous) => [...previous, staged]);
          } catch (error) {
            if (!current.active || current.generation !== generation) return;
            current.count -= 1;
            latest.current.onError(
              error instanceof Error ? error.message : "Could not upload the file.",
            );
          } finally {
            if (current.active && current.generation === generation) {
              current.uploading -= 1;
              setUploading(current.uploading);
            }
          }
        }
      })();
    },
    [maxCount],
  );

  const remove = React.useCallback((id: string) => {
    const removed = state.current.staged.get(id);
    if (!removed) return;
    state.current.staged.delete(id);
    state.current.count -= 1;
    if (removed.previewUrl) {
      URL.revokeObjectURL(removed.previewUrl);
      state.current.urls.delete(removed.previewUrl);
    }
    setPending((previous) => previous.filter((file) => file.id !== id));
  }, []);
  const clear = React.useCallback(() => {
    state.current.generation += 1;
    state.current.count = 0;
    state.current.uploading = 0;
    state.current.staged.clear();
    releaseUrls();
    setPending([]);
    setUploading(0);
  }, [releaseUrls]);
  const isUploading = React.useCallback(() => state.current.uploading > 0, []);
  return { pending, uploading, addFiles, remove, clear, isUploading };
}
