'use client';

import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, X, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

interface UploadedFile {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachmentId?: number;
}

interface FileUploadZoneProps {
  onFiles?: (files: File[]) => void;
  /** API path for upload, e.g. "/attachments/upload" or "/attachments/upload/public" */
  uploadEndpoint?: string;
  /** Called when files are successfully uploaded; receives the DB attachment ids */
  onUploaded?: (ids: number[]) => void;
  accept?: string;
  maxSizeMb?: number;
  maxFiles?: number;
  className?: string;
}

export function FileUploadZone({
  onFiles,
  uploadEndpoint,
  onUploaded,
  accept = '*',
  maxSizeMb = 25,
  maxFiles = 10,
  className,
}: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

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

      // Auth travels via the HttpOnly cookie (credentials:'include'); no Bearer
      // header — the JWT is never exposed to JS. Do NOT set Content-Type manually:
      // let the browser set the multipart boundary.

      try {
        const res = await fetch(`${API_URL}${uploadEndpoint}`, {
          method: 'POST',
          credentials: 'include',
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
      }
    },
    [uploadEndpoint, onUploaded],
  );

  const processFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const validFiles = Array.from(files)
        .slice(0, maxFiles - uploads.length)
        .filter((f) => f.size <= maxSizeMb * 1024 * 1024);

      if (validFiles.length === 0) return;

      const newUploads: UploadedFile[] = validFiles.map((file) => ({
        id: `${Date.now()}-${file.name}`,
        file,
        progress: 0,
        status: 'uploading',
      }));

      setUploads((prev) => [...prev, ...newUploads]);
      onFiles?.(validFiles);

      // Upload each file
      newUploads.forEach((upload) => {
        void uploadFile(upload);
      });
    },
    [maxFiles, maxSizeMb, onFiles, uploads.length, uploadFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(e.dataTransfer.files);
    },
    [processFiles],
  );

  const removeFile = (id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  };

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
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
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
              <button
                onClick={() => removeFile(upload.id)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground"
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
}
