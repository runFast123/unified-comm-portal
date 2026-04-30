import { Skeleton, SkeletonCard } from '@/components/ui/skeleton'

export default function DashboardPageLoading() {
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header skeleton */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-48 rounded-lg" />
      </div>

      {/* Date range skeleton */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-20 rounded-lg" />
        <Skeleton className="h-8 w-20 rounded-lg" />
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>

      {/* KPI Row - 4 skeleton cards for the KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>

      {/* Wider skeleton block for the main chart area */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="h-3 w-56 rounded" />
          </div>
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
        <Skeleton className="mt-6 h-64 w-full rounded-xl" />
      </div>

      {/* Secondary row — channel breakdown + category breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          <Skeleton className="h-5 w-40 rounded" />
          <Skeleton className="mt-1 h-3 w-56 rounded" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-100 p-4 text-center"
              >
                <Skeleton className="mx-auto h-5 w-20 rounded" />
                <Skeleton className="mx-auto mt-3 h-9 w-12 rounded" />
                <Skeleton className="mx-auto mt-1 h-3 w-16 rounded" />
                <Skeleton className="mx-auto mt-3 h-3 w-28 rounded" />
                <Skeleton className="mt-3 h-1 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
          <Skeleton className="h-5 w-44 rounded" />
          <Skeleton className="mt-1 h-3 w-60 rounded" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 w-32 flex-shrink-0 rounded" />
                <Skeleton className="h-6 flex-1 rounded" />
                <Skeleton className="h-4 w-8 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Accounts Overview Table skeleton */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
        <Skeleton className="h-5 w-48 rounded" />
        <Skeleton className="mt-1 h-3 w-72 rounded" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-10 w-full rounded-md" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}
