'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getChannelLabel, timeAgo } from '@/lib/utils'
import type { ChannelType } from '@/types/database'
import { ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react'

export interface CompanyPerformance {
  id: string
  name: string
  channel_type: ChannelType
  gmail_address: string | null
  totalMessages: number
  pendingReplies: number
  aiRepliesSent: number
  responseRate: number
  topCategory: string | null
  lastActivity: string | null
}

type SortKey = 'name' | 'totalMessages' | 'pendingReplies' | 'aiRepliesSent' | 'responseRate' | 'lastActivity'

interface Props {
  stats: CompanyPerformance[]
}

export function CompanyStatsTable({ stats }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('totalMessages')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = [...stats].sort((a, b) => {
    let cmp = 0
    switch (sortKey) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'totalMessages': cmp = a.totalMessages - b.totalMessages; break
      case 'pendingReplies': cmp = a.pendingReplies - b.pendingReplies; break
      case 'aiRepliesSent': cmp = a.aiRepliesSent - b.aiRepliesSent; break
      case 'responseRate': cmp = a.responseRate - b.responseRate; break
      case 'lastActivity':
        cmp = (a.lastActivity || '').localeCompare(b.lastActivity || '')
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 text-gray-300" />
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-teal-600" />
      : <ChevronDown className="h-3 w-3 text-teal-600" />
  }

  const SortableHead = ({ col, children }: { col: SortKey; children: React.ReactNode }) => (
    <TableHead>
      <button
        onClick={() => toggleSort(col)}
        className="inline-flex items-center gap-1 hover:text-teal-700 transition-colors"
      >
        {children}
        <SortIcon col={col} />
      </button>
    </TableHead>
  )

  const getRateColor = (rate: number) => {
    if (rate >= 50) return 'text-green-600'
    if (rate >= 20) return 'text-amber-600'
    return 'text-red-600'
  }

  if (stats.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-400">
        No company data available for this period.
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead col="name">Company</SortableHead>
          <TableHead>Email</TableHead>
          <SortableHead col="totalMessages">Messages</SortableHead>
          <SortableHead col="pendingReplies">Pending</SortableHead>
          <SortableHead col="aiRepliesSent">AI Sent</SortableHead>
          <SortableHead col="responseRate">Response Rate</SortableHead>
          <TableHead>Top Category</TableHead>
          <SortableHead col="lastActivity">Last Active</SortableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((s) => (
          <TableRow key={s.id} className="cursor-pointer hover:bg-gray-50 transition-colors">
            <TableCell>
              <Link href={`/accounts/${s.id}`} className="flex items-center gap-2 font-medium text-gray-900 hover:text-teal-700">
                <ChannelIcon channel={s.channel_type} size={16} />
                {s.name}
              </Link>
            </TableCell>
            <TableCell>
              <span className="text-xs text-gray-500 truncate max-w-[160px] block">
                {s.gmail_address || <span className="text-gray-300 italic">--</span>}
              </span>
            </TableCell>
            <TableCell>
              <span className="font-semibold text-gray-900">{s.totalMessages}</span>
            </TableCell>
            <TableCell>
              <span className={`font-semibold ${s.pendingReplies > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                {s.pendingReplies}
              </span>
            </TableCell>
            <TableCell>
              <span className="font-semibold text-teal-700">{s.aiRepliesSent}</span>
            </TableCell>
            <TableCell>
              <span className={`font-semibold ${getRateColor(s.responseRate)}`}>
                {s.responseRate}%
              </span>
            </TableCell>
            <TableCell>
              {s.topCategory ? (
                <Badge variant="default" size="sm">{s.topCategory}</Badge>
              ) : (
                <span className="text-xs text-gray-300">--</span>
              )}
            </TableCell>
            <TableCell>
              <span className="text-sm text-gray-500">
                {s.lastActivity ? timeAgo(s.lastActivity) : '--'}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
