import { Skeleton } from '@/components/ui/skeleton'

export default function ConversationLoading() {
  return (
    <div className="animate-in fade-in duration-300">
      {/* Conversation header */}
      <div className="flex items-start justify-between gap-4 border-b border-gray-200/80 bg-gradient-to-b from-gray-50/60 to-white px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-4 w-48 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-3 w-16 rounded-full" />
              <Skeleton className="h-3 w-20 rounded-full" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
      </div>

      {/* Body: thread on the left + AI sidebar on the right */}
      <div className="grid grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[1fr_340px]">
        {/* Thread — alternating message bubbles */}
        <div className="space-y-5">
          {/* Inbound bubble */}
          <div className="flex items-start gap-3">
            <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-32 rounded" />
              <div className="rounded-2xl rounded-tl-sm border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <Skeleton className="h-3 w-72 rounded" />
                <Skeleton className="mt-2 h-3 w-64 rounded" />
                <Skeleton className="mt-2 h-3 w-56 rounded" />
              </div>
            </div>
          </div>

          {/* Outbound bubble */}
          <div className="flex items-start justify-end gap-3">
            <div className="flex flex-col items-end space-y-2">
              <Skeleton className="h-3 w-28 rounded" />
              <div className="rounded-2xl rounded-tr-sm bg-teal-50 p-4 ring-1 ring-teal-200/60">
                <Skeleton className="h-3 w-56 rounded" />
                <Skeleton className="mt-2 h-3 w-48 rounded" />
              </div>
            </div>
            <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
          </div>

          {/* Inbound bubble */}
          <div className="flex items-start gap-3">
            <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-32 rounded" />
              <div className="rounded-2xl rounded-tl-sm border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <Skeleton className="h-3 w-64 rounded" />
                <Skeleton className="mt-2 h-3 w-72 rounded" />
              </div>
            </div>
          </div>

          {/* Reply composer */}
          <div className="mt-6 rounded-2xl border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            <Skeleton className="h-4 w-24 rounded" />
            <Skeleton className="mt-3 h-24 w-full rounded-lg" />
            <div className="mt-3 flex items-center justify-between">
              <Skeleton className="h-8 w-28 rounded-lg" />
              <Skeleton className="h-8 w-24 rounded-lg" />
            </div>
          </div>
        </div>

        {/* AI sidebar */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-4 w-28 rounded" />
            </div>
            <div className="mt-4 space-y-2">
              <Skeleton className="h-3 w-11/12 rounded" />
              <Skeleton className="h-3 w-10/12 rounded" />
              <Skeleton className="h-3 w-8/12 rounded" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
            <Skeleton className="h-4 w-32 rounded" />
            <div className="mt-3 space-y-2">
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
            <Skeleton className="h-4 w-24 rounded" />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
