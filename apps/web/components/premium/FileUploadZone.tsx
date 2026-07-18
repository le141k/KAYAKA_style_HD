'use client';

import { useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, X, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithCsrf } from '@/lib/api';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

interface UploadedFile {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachmentId?: number;
}

export interface FileUploadZoneHandle {
  /** Clear all uploaded files (call after a successful form submit). */
  clear: () => void;
}

interface FileUploadZoneProps {
  onFiles?: (files: File[]) => void;
  /** API path for upload, e.g. "/attachments/upload" or "/attachments/upload/public" */
  uploadEndpoint?: string;
  /** Called when files are successfully uploaded; receives the DB attachment ids */
  onUploaded?: (ids: number[]) => void;
  /** Called when a completed upload is removed from the form. */
  onRemoved?: (id: number) => void;
  /**
   * Per-session orphan-claim secret sent with each public upload. Bind orphan
   * attachments to the submit that follows so they can't be adopted by others.
   */
  claimToken?: string;
  /** One-time action-bound challenge required by the anonymous public upload endpoint. */
  challengeToken?: string;
  onChallengeConsumed?: () => void;
  accept?: string;
  maxSizeMb?: number;
  maxFiles?: number;
  className?: string;
}

export const FileUploadZone = forwardRef<FileUploadZoneHandle, FileUploadZoneProps>(function FileUploadZone(
  {
    onFiles,
    uploadEndpoint,
    onUploaded,
    onRemoved,
    claimToken,
    challengeToken,
    onChallengeConsumed,
    accept = '*',
    maxSizeMb = 25,
    maxFiles = 10,
    className,
  },
  ref,
) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Expose clear() to parent forms via ref so they can reset after submit.
  useImperativeHandle(ref, () => ({
    clear: () => setUploads([]),
  }));

  const uploadFile = useCallback(
    async (upload: UploadedFile): Promise<void> => {
      if (!uploadEndpoint) {
        // No real endpoint → simulate progress (legacy behaviour)
        let progress = 0;
        const interval = setInterval(() => {
          progress += Math.random() * 20 + 10;
          if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            setUploads((prev) =>
              prev.map((u) => (u.id === upload.id ? { ...u, progress: 100, status: 'done' } : u)),
            );
          } else {
            setUploads((prev) => prev.map((u) => (u.id === upload.id ? { ...u, progress } : u)));
          }
        }, 120);
        return;
      }

      const formData = new FormData();
      formData.append('files', upload.file);
      // Bind anonymous orphan uploads to this submit session (server scopes adoption).
      if (claimToken) formData.append('claimToken', claimToken);

      // Auth travels via the HttpOnly cookie (credentials:'include'); no Bearer
      // header — the JWT is never exposed to JS. Do NOT set Content-Type manually:
      // let the browser set the multipart boundary.

      try {
        const res = await fetchWithCsrf(`${API_URL}${uploadEndpoint}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            ...(challengeToken ? { 'x-turnstile-token': challengeToken } : {}),
          },
          body: formData,
        });

        if (!res.ok) {
          setUploads((prev) =>
            prev.map((u) => (u.id === upload.id ? { ...u, progress: 0, status: 'error' } : u)),
          );
          return;
        }

        const data = (await res.json()) as { attachments: { id: number }[] } | { attachmentIds: number[] };

        const ids = 'attachments' in data ? data.attachments.map((a) => a.id) : data.attachmentIds;

        const attachmentId = ids[0];

        setUploads((prev) =>
          prev.map((u) => (u.id === upload.id ? { ...u, progress: 100, status: 'done', attachmentId } : u)),
        );

        if (ids.length > 0) {
          onUploaded?.(ids);
        }
      } catch {
        setUploads((prev) =>
          prev.map((u) => (u.id === upload.id ? { ...u, progress: 0, status: 'error' } : u)),
        );
      } finally {
        if (uploadEndpoint.endsWith('/public')) onChallengeConsumed?.();
      }
    },
    [uploadEndpoint, onUploaded, claimToken, challengeToken, onChallengeConsumed],
  );

  const uploadBatch = useCallback(
    async (batch: UploadedFile[]): Promise<void> => {
      if (!uploadEndpoint) {
        await Promise.all(batch.map(uploadFile));
        return;
      }
      if (uploadEndpoint.endsWith('/public') && !challengeToken) {
        setUploads((prev) =>
          prev.map((item) =>
            batch.some((candidate) => candidate.id === item.id)
              ? { ...item, progress: 0, status: 'error' }
              : item,
          ),
        );
        return;
      }

      const formData = new FormData();
      for (const item of batch) formData.append('files', item.file);
      if (claimToken) formData.append('claimToken', claimToken);
      try {
        const res = await fetchWithCsrf(`${API_URL}${uploadEndpoint}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            ...(challengeToken ? { 'x-turnstile-token': challengeToken } : {}),
          },
          body: formData,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { attachments: { id: number }[] } | { attachmentIds: number[] };
        const ids = 'attachments' in data ? data.attachments.map((a) => a.id) : data.attachmentIds;
        setUploads((prev) =>
          prev.map((item) => {
            const index = batch.findIndex((candidate) => candidate.id === item.id);
            return index === -1 ? item : { ...item, progress: 100, status: 'done', attachmentId: ids[index] };
          }),
        );
        onUploaded?.(ids);
      } catch {
        setUploads((prev) =>
          prev.map((item) =>
            batch.some((candidate) => candidate.id === item.id)
              ? { ...item, progress: 0, status: 'error' }
              : item,
          ),
        );
      } finally {
        if (uploadEndpoint.endsWith('/public')) onChallengeConsumed?.();
      }
    },
    [challengeToken, claimToken, onChallengeConsumed, onUploaded, uploadEndpoint, uploadFile],
  );

  const processFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const validFiles = Array.from(files)
        .slice(0, maxFiles - uploads.length)
        .filter((f) => f.size <= maxSizeMb * 1024 * 1024);

      if (validFiles.length === 0) return;

      const newUploads: UploadedFile[] = validFiles.map((file) => ({
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: 'uploading',
      }));

      setUploads((prev) => [...prev, ...newUploads]);
      onFiles?.(validFiles);

      // Public challenges are single-use, so anonymous files are sent in one bounded request.
      if (uploadEndpoint?.endsWith('/public')) void uploadBatch(newUploads);
      else newUploads.forEach((upload) => void uploadFile(upload));
    },
    [maxFiles, maxSizeMb, onFiles, uploads.length, uploadBatch, uploadEndpoint, uploadFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(e.dataTransfer.files);
    },
    [processFiles],
  );

  const removeFile = useCallback(
    (id: string) => {
      const removed = uploads.find((upload) => upload.id === id);
      if (removed?.attachmentId !== undefined) onRemoved?.(removed.attachmentId);
      setUploads((prev) => prev.filter((upload) => upload.id !== id));
    },
    [onRemoved, uploads],
  );

  return (
    <div className={cn('space-y-3', className)}>
      {/* Drop zone */}
      <motion.div
        animate={isDragging ? { scale: 1.01, borderColor: 'hsl(var(--primary))' } : { scale: 1 }}
        transition={{ duration: 0.15 }}
        onDragEnter={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border p-8 transition-colors',
          'hover:border-primary/50 hover:bg-primary/5',
          isDragging && 'border-primary bg-primary/5',
        )}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label="Загрузить файлы"
      >
        <motion.div
          animate={isDragging ? { y: -4 } : { y: 0 }}
          transition={{ duration: 0.2 }}
          className={cn(
            'rounded-full p-3 transition-colors',
            isDragging ? 'bg-primary/10' : 'bg-muted group-hover:bg-primary/10',
          )}
        >
          <Upload
            className={cn(
              'h-6 w-6 transition-colors',
              isDragging ? 'text-primary' : 'text-muted-foreground group-hover:text-primary',
            )}
          />
        </motion.div>

        <div className="text-center">
          <p className="text-sm font-medium">
            {isDragging ? 'Отпустите для загрузки' : 'Перетащите файлы сюда'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            или нажмите для выбора · до {maxSizeMb} МБ на файл
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          onChange={(e) => processFiles(e.target.files)}
          aria-hidden="true"
        />
      </motion.div>

      {/* Uploaded files */}
      <AnimatePresence initial={false}>
        {uploads.map((upload) => (
          <motion.div
            key={upload.id}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
              <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{upload.file.name}</p>
                <div className="mt-1 flex items-center gap-2">
                  {upload.status === 'uploading' ? (
                    <>
                      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <motion.div
                          className="h-full bg-primary"
                          animate={{ width: `${upload.progress}%` }}
                          transition={{ duration: 0.1 }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {Math.round(upload.progress)}%
                      </span>
                    </>
                  ) : upload.status === 'done' ? (
                    <span className="flex items-center gap-1 text-[10px] text-status-resolved">
                      <CheckCircle2 className="h-3 w-3" />
                      Загружено
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      Ошибка
                    </span>
                  )}
                </div>
              </div>
              {/* type="button" prevents this from submitting the parent form */}
              <button
                type="button"
                onClick={() => removeFile(upload.id)}
                disabled={upload.status === 'uploading'}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={`Удалить ${upload.file.name}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});
