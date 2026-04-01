'use client'

import Link from 'next/link'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { PhaseIndicator } from '@/components/ui/phase-indicator'
import { Badge } from '@/components/ui/badge'
import { timeAgo } from '@/lib/utils'
import type { AccountOverview } from '@/types/database'
import type { ChannelFilterValue } from './channel-filter'

interface AccountsTableProps {
  accounts: AccountOverview[]
  filter: ChannelFilterValue
}

function getBaseName(name: string): string {
  return name.replace(/\s+Teams$/i, '').trim()
}

interface GroupedAccount {
  baseName: string
  email: AccountOverview | null
  teams: AccountOverview | null
  totalPending: number
  lastMessageTime: string | null
}

export function AccountsTable({ accounts, filter }: AccountsTableProps) {
  const filtered =
    filter === 'all'
      ? accounts
      : accounts.filter((a) => a.channel_type === filter)

  // Group by company name
  const groupMap = new Map<string, GroupedAccount>()
  for (const acc of filtered) {
    const baseName = getBaseName(acc.name)
    const existing = groupMap.get(baseName) || {
      baseName,
      email: null,
      teams: null,
      totalPending: 0,
      lastMessageTime: null,
    }

    if (acc.channel_type === 'email') existing.email = acc
    else if (acc.channel_type === 'teams') existing.teams = acc

    existing.totalPending += acc.pendingCount
    if (acc.lastMessageTime) {
      if (!existing.lastMessageTime || acc.lastMessageTime > existing.lastMessageTime) {
        existing.lastMessageTime = acc.lastMessageTime
      }
    }

    groupMap.set(baseName, existing)
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => a.baseName.localeCompare(b.baseName))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Company</TableHead>
          <TableHead>Channels</TableHead>
          <TableHead>Phase Status</TableHead>
          <TableHead className="text-center">Pending</TableHead>
          <TableHead>Last Message</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const primary = group.email || group.teams
          if (!primary) return null
          return (
            <TableRow key={group.baseName}>
              <TableCell>
                <Link
                  href={`/accounts/${primary.id}`}
                  className="font-medium text-gray-900 hover:text-teal-600 transition-colors"
                >
                  {group.baseName}
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {group.email && (
                    <Link href={`/accounts/${group.email.id}`} className="flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-xs text-red-700 hover:bg-red-100 transition-colors" title="Email">
                      <ChannelIcon channel="email" size={12} />
                      Email
                    </Link>
                  )}
                  {group.teams && (
                    <Link href={`/accounts/${group.teams.id}`} className="flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100 transition-colors" title="Teams">
                      <ChannelIcon channel="teams" size={12} />
                      Teams
                    </Link>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <PhaseIndicator
                  phase1_enabled={primary.phase1_enabled}
                  phase2_enabled={primary.phase2_enabled}
                />
              </TableCell>
              <TableCell className="text-center">
                {group.totalPending > 0 ? (
                  <Badge variant={group.totalPending >= 4 ? 'danger' : 'warning'} size="sm">
                    {group.totalPending}
                  </Badge>
                ) : (
                  <span className="text-gray-400">0</span>
                )}
              </TableCell>
              <TableCell>
                <span className="text-sm text-gray-500">
                  {group.lastMessageTime
                    ? `${timeAgo(group.lastMessageTime)} ago`
                    : 'No messages yet'}
                </span>
              </TableCell>
            </TableRow>
          )
        })}
        {groups.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="py-8 text-center text-gray-400">
              No accounts match the selected filter.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
