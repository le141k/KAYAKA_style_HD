import { Skeleton } from '@/components/ui/skeleton';

export function TicketListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Загрузка заявок">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <Skeleton className="h-3.5 w-20" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

export function DashboardStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-5" aria-busy="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className={`rounded-xl border border-border bg-card p-5${i === 4 ? ' col-span-2 lg:col-span-1' : ''}`}
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-10 w-10 rounded-lg" />
          </div>
          <div className="mt-3 flex justify-end">
            <Skeleton className="h-7 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TicketDetailSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]" aria-busy="true">
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-5">
            <div className="flex gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <Skeleton className="mb-3 h-4 w-20" />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function KanbanSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto" aria-busy="true">
      {Array.from({ length: 5 }).map((_, col) => (
        <div key={col} className="min-h-80 w-72 flex-shrink-0 rounded-xl border border-border bg-muted/40">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-6 rounded-full" />
          </div>
          <div className="space-y-2 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-4 w-14 rounded-full" />
                </div>
                <Skeleton className="mb-1 h-3.5 w-full" />
                <Skeleton className="mb-2 h-3.5 w-3/4" />
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-12 rounded-full" />
                  <Skeleton className="h-5 w-5 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
