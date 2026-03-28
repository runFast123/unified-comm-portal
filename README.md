# Unified Communication Portal

A full-stack multi-channel communication platform that unifies **Email**, **Microsoft Teams**, and **WhatsApp** into a single intelligent inbox with AI-powered reply generation, message classification, and workflow automation.

**Live Demo:** [unified-comm-portal.vercel.app](https://unified-comm-portal.vercel.app)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 16 + React 19 (TypeScript) |
| **Database** | Supabase (PostgreSQL + Auth + RLS) |
| **Styling** | Tailwind CSS 4 + Lucide Icons |
| **Automation** | n8n (workflow orchestration) |
| **AI** | NVIDIA NIM / OpenAI-compatible API |
| **Charts** | Recharts |
| **PDF Export** | jsPDF + jspdf-autotable |
| **Deployment** | Vercel |

---

## Features

### Core
- **Unified Inbox** - All channels (Email, Teams, WhatsApp) in one view with real-time updates
- **AI Classification** - Automatic category, sentiment, and urgency detection for every inbound message
- **AI Reply Generation** - Context-aware draft replies using knowledge base and conversation history
- **Spam Detection** - Automatic spam filtering with dedicated spam archive

### Account Management
- **Phase-based Rollout** - Phase 1 (Monitor) and Phase 2 (AI Reply) per account
- **Trust Mode** - Auto-send AI replies without human approval when confidence is high
- **Per-account AI Prompts** - Custom system prompts for each company account
- **Working Hours & Timezone** - Per-account business hours configuration

### Collaboration
- **Agent Assignment** - Assign conversations to team members
- **Internal Notes** - Private notes on conversations (pinnable)
- **Reply Templates** - Pre-written responses with keyboard shortcuts
- **Conversation Status** - Active, In Progress, Waiting on Customer, Resolved, Escalated, Archived

### Analytics & Reporting
- **Dashboard KPIs** - Messages today, pending replies, AI send rate, avg response time
- **Reports** - Overview, Channel breakdown, Categories, AI Performance, Imported Data
- **SLA Tracking** - Warning and critical thresholds with auto-escalation
- **PDF & CSV Export** - Export reports in multiple formats

### Integrations
- **Google Sheets Sync** - Import data from Google Sheets for AI context
- **Knowledge Base** - GitHub-synced articles used by AI for replies
- **n8n Workflows** - Email monitoring, reply sending, and webhook automation
- **Notification Rules** - Email, in-portal, and Slack notifications

### Security
- **Role-based Access** - Admin, Reviewer, and Viewer roles
- **Row Level Security** - Supabase RLS policies on all tables
- **Account Scoping** - Users only see data for their assigned company
- **Admin Guard** - Server-side layout protection for admin routes

---

## Project Structure

```
src/
├── app/
│   ├── (auth)/                    # Login & Signup pages
│   ├── (dashboard)/               # Main application
│   │   ├── dashboard/             # KPI dashboard
│   │   ├── inbox/                 # Unified inbox
│   │   ├── accounts/              # Account overview (user)
│   │   ├── contacts/              # Contact management
│   │   ├── reports/               # Analytics & charts
│   │   ├── knowledge-base/        # KB articles
│   │   ├── templates/             # Reply templates
│   │   ├── sheets/                # Google Sheets sync
│   │   ├── conversations/[id]/    # Conversation detail
│   │   └── admin/                 # Admin-only pages
│   │       ├── accounts/          # Account management + toggles
│   │       ├── channels/          # Channel configuration
│   │       ├── ai-settings/       # AI provider settings
│   │       ├── users/             # User management
│   │       ├── notifications/     # Notification rules
│   │       └── health/            # System health monitor
│   └── api/
│       ├── ai-reply/              # Generate AI replies
│       ├── classify/              # Message classification
│       ├── export/                # PDF/CSV export
│       ├── sheets-sync/           # Google Sheets sync
│       ├── sla-check/             # SLA monitoring
│       └── webhooks/
│           ├── email/             # Email ingestion from n8n
│           ├── teams/             # Teams message ingestion
│           ├── teams-reply/       # Send reply via Teams
│           └── whatsapp/          # WhatsApp webhook
├── components/
│   ├── dashboard/                 # Dashboard-specific components
│   ├── inbox/                     # Inbox components (filters, list, preview)
│   ├── reports/                   # Chart & report components
│   └── ui/                        # Shared UI components
├── context/                       # React context (user)
├── hooks/                         # Custom hooks (realtime, notifications)
├── lib/                           # Utilities, Supabase clients, schema
└── types/                         # TypeScript type definitions

n8n-workflows/                     # n8n workflow JSON configs
```

---

## Database Schema

**21 tables** with Row Level Security enabled on all:

| Table | Purpose |
|-------|---------|
| `users` | Portal users with roles (admin/reviewer/viewer) |
| `accounts` | Communication channel accounts (10 companies) |
| `conversations` | Chat threads with status, priority, SLA tracking |
| `messages` | Individual messages (inbound/outbound) with spam detection |
| `message_classifications` | AI-generated category, sentiment, urgency |
| `ai_replies` | AI draft replies with approval workflow |
| `ai_config` | AI provider settings (model, temperature, prompts) |
| `kb_articles` | Knowledge base articles for AI context |
| `kb_hits` | KB article usage tracking per AI reply |
| `channel_configs` | Per-account channel credentials |
| `google_sheets_sync` | Sheet sync configuration |
| `imported_records` | Data imported from Google Sheets |
| `reply_templates` | Quick reply templates with shortcuts |
| `conversation_notes` | Internal notes on conversations |
| `notification_rules` | Alert configuration per account |
| `audit_log` | System audit trail |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Supabase project ([supabase.com](https://supabase.com))
- n8n instance ([n8n.io](https://n8n.io)) - for email/Teams automation
- AI API key (NVIDIA NIM, OpenAI, or compatible)

### 1. Clone & Install

```bash
git clone https://github.com/runFast123/unified-comm-portal.git
cd unified-comm-portal
npm install
```

### 2. Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.local.example .env.local
```

Required variables:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# n8n Integration
N8N_BASE_URL=https://your-n8n-instance.app.n8n.cloud
N8N_API_KEY=your-n8n-api-key
N8N_WEBHOOK_SECRET=your-webhook-secret

# AI Configuration
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_API_KEY=your-ai-api-key
AI_MODEL=openai/gpt-oss-120b
AI_MAX_TOKENS=1024
AI_TEMPERATURE=0.7
```

### 3. Database Setup

Run the schema in your Supabase SQL editor:

```bash
# Copy the contents of src/lib/schema.sql into Supabase SQL Editor and execute
```

This creates all tables, enums, indexes, RLS policies, and triggers.

### 4. n8n Workflows

Import the workflow JSON files from `n8n-workflows/` into your n8n instance:

- `gmail-monitor.json` - Monitors Gmail inboxes and sends messages to the portal
- `gmail-reply.json` - Sends approved replies back via Gmail
- `teams-monitor.json` - Monitors Teams channels
- `teams-reply.json` - Sends replies via Teams

See `n8n-workflows/SETUP-GUIDE.md` for detailed setup instructions.

### 5. Run

```bash
# Development
npm run dev

# Production build
npm run build
npm start
```

The app runs on `http://localhost:3000` by default.

---

## API Routes

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/ai-reply` | POST | Session | Generate AI reply for a message |
| `/api/classify` | POST | Session | Classify message (category, sentiment, urgency) |
| `/api/export` | POST | Session | Export reports as PDF or CSV |
| `/api/sheets-sync` | GET/POST | Session/Webhook | Sync Google Sheets data |
| `/api/sla-check` | POST | Session | Check SLA breaches |
| `/api/test-ai` | POST | Session | Test AI provider connection |
| `/api/test-connection` | POST | Session | Test channel connections |
| `/api/webhooks/email` | POST | Webhook Secret | Receive emails from n8n |
| `/api/webhooks/teams` | POST | Webhook Secret | Receive Teams messages |
| `/api/webhooks/teams-reply` | POST | Session | Send reply via Teams |
| `/api/webhooks/whatsapp` | GET/POST | Verify Token | WhatsApp webhook |

---

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access: manage accounts, users, AI settings, channels, all data |
| **Reviewer** | View & manage conversations for assigned company, approve AI replies |
| **Viewer** | View-only access to assigned company's data |

---

## Deployment

The project is configured for **Vercel** deployment:

```bash
# Deploy to Vercel
npx vercel --prod
```

Make sure to set all environment variables in Vercel's project settings.

---

## License

Private project. All rights reserved.
