import type { Metadata } from 'next'
import { ToastWrapper } from '@/components/ui/toast-wrapper'
import './globals.css'

export const metadata: Metadata = {
  title: 'Unified Communication Portal',
  description: 'Manage 20 company accounts (Email + Teams) with AI-powered monitoring and auto-reply',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      {/*
        suppressHydrationWarning is scoped to this single <body> element.
        It silences only the attribute-mismatch warning caused by browser
        extensions (Grammarly, password managers, etc.) that inject marker
        attributes on <body> before React hydrates. Hydration mismatches
        inside <body> — in any child component — are still reported.
      */}
      <body className="bg-background text-foreground antialiased" suppressHydrationWarning>
        <ToastWrapper>{children}</ToastWrapper>
      </body>
    </html>
  )
}
