#!/usr/bin/env node
/**
 * Creates Teams accounts in Supabase + Teams Monitor & Reply workflows in n8n
 * Same pattern as email: n8n monitors Teams → POSTs to portal → portal triggers n8n for reply
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xrqfprciqeyliwxcedvv.supabase.co'
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhycWZwcmNpcWV5bGl3eGNlZHZ2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzk4MDQxOCwiZXhwIjoyMDg5NTU2NDE4fQ.Xdg-nPRoh3TFfwWtoZgNz2uJ3gK8g7ObUty5Lq9pxa4'

const N8N_BASE_URL = 'https://mcmflow.app.n8n.cloud'
const N8N_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MTU4ZmM1MC05NTVhLTRiOTAtODA0OC1mYzNkOGZlYTgzZjUiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMjgxNDIwNzItZDgwYi00YjAxLWFhNDktYzRkMDY1OGYwMzIwIiwiaWF0IjoxNzczOTk4MjQ1fQ.5kD4PR6AUbCijxwkn9U3D_fm3wG9HAfldC6qyTUUYQo'
const N8N_PROJECT_ID = 'y8rCeAdxgp9AyOwN' // "Unified Communication Portal"

const PORTAL_URL = 'https://unified-comm-portal.vercel.app'
const WEBHOOK_SECRET = 'my-webhook-secret-123'

// Microsoft Teams credential in n8n
const TEAMS_CREDENTIAL_ID = '0lLW5CbkT2yJCDAB'
const TEAMS_CREDENTIAL_NAME = 'Aman testing'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ─── Companies ────────────────────────────────────────────────────────────────
const COMPANIES = [
  'Acepeak', 'Ajoxi', 'Letsdial', 'Meratalk', 'Mycountrymobile',
  'Rozper', 'Softtop', 'Techopensystems', 'Teloz', 'Twiching',
]

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ─── n8n API helpers ──────────────────────────────────────────────────────────

async function n8nPost(path, body) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`n8n API ${path} failed (${res.status}): ${text}`)
  }
  return res.json()
}

async function n8nPut(path, body) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`n8n API PUT ${path} failed (${res.status}): ${text}`)
  }
  return res.json()
}

// ─── Build Teams Monitor Workflow (same pattern as Gmail Trigger) ─────────────

function buildTeamsMonitorWorkflow(companyName, accountId) {
  const s = slug(companyName)
  return {
    name: `${companyName} - Teams Monitor`,
    nodes: [
      {
        name: 'Teams Trigger',
        type: 'n8n-nodes-base.microsoftTeamsTrigger',
        typeVersion: 1,
        parameters: {
          event: 'newChannelMessage',
          teamId: { __rl: true, mode: 'list', value: '' },
          channelId: { __rl: true, mode: 'list', value: '' },
          pollTimes: {
            item: [{ mode: 'everyMinute' }],
          },
        },
        credentials: {
          microsoftTeamsOAuth2Api: {
            id: TEAMS_CREDENTIAL_ID,
            name: TEAMS_CREDENTIAL_NAME,
          },
        },
        position: [250, 300],
        id: 'tt1',
      },
      {
        name: 'Map Fields',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        parameters: {
          mode: 'manual',
          duplicateItem: false,
          assignments: {
            assignments: [
              {
                id: 'a1',
                name: 'account_id',
                value: accountId,
                type: 'string',
              },
              {
                id: 'a2',
                name: 'sender_name',
                value: '={{ $json.from?.user?.displayName || $json.from?.displayName || "Unknown" }}',
                type: 'string',
              },
              {
                id: 'a3',
                name: 'sender_email',
                value: '={{ $json.from?.user?.email || $json.from?.emailAddress?.address || "" }}',
                type: 'string',
              },
              {
                id: 'a4',
                name: 'message_text',
                value: '={{ ($json.body?.content || "").replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim() }}',
                type: 'string',
              },
              {
                id: 'a5',
                name: 'teams_message_id',
                value: '={{ $json.id }}',
                type: 'string',
              },
              {
                id: 'a6',
                name: 'teams_chat_id',
                value: '={{ $json.channelIdentity?.channelId || $json.chatId || "" }}',
                type: 'string',
              },
              {
                id: 'a7',
                name: 'timestamp',
                value: '={{ $json.createdDateTime || new Date().toISOString() }}',
                type: 'string',
              },
              {
                id: 'a8',
                name: 'message_type',
                value: 'message',
                type: 'string',
              },
            ],
          },
          options: {},
        },
        position: [500, 300],
        id: 'set1',
      },
      {
        name: 'Send to Portal',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: 'POST',
          url: `${PORTAL_URL}/api/webhooks/teams`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'X-Webhook-Secret', value: WEBHOOK_SECRET },
            ],
          },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ account_id: $json.account_id, sender_name: $json.sender_name, sender_email: $json.sender_email, message_text: $json.message_text, teams_message_id: $json.teams_message_id, teams_chat_id: $json.teams_chat_id, timestamp: $json.timestamp, message_type: $json.message_type }) }}',
          options: { timeout: 30000 },
        },
        position: [750, 300],
        id: 'hp1',
      },
    ],
    connections: {
      'Teams Trigger': {
        main: [[{ node: 'Map Fields', type: 'main', index: 0 }]],
      },
      'Map Fields': {
        main: [[{ node: 'Send to Portal', type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
    },
  }
}

// ─── Build Teams Reply Workflow (webhook → Teams send message) ────────────────

function buildTeamsReplyWorkflow(companyName, accountId) {
  const s = slug(companyName)
  return {
    name: `${companyName} - Teams Reply`,
    nodes: [
      {
        name: 'Portal Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        parameters: {
          httpMethod: 'POST',
          path: `teams-reply-${s}`,
          responseMode: 'responseNode',
          options: {},
        },
        position: [250, 300],
        id: 'wh1',
        webhookId: `teams-reply-${s}`,
      },
      {
        name: 'Extract Reply Data',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        parameters: {
          mode: 'manual',
          duplicateItem: false,
          assignments: {
            assignments: [
              {
                id: 'r1',
                name: 'reply_text',
                value: '={{ $json.body.data?.reply_text || $json.body.reply_text || "" }}',
                type: 'string',
              },
              {
                id: 'r2',
                name: 'conversation_id',
                value: '={{ $json.body.data?.conversation_id || $json.body.conversation_id || "" }}',
                type: 'string',
              },
              {
                id: 'r3',
                name: 'teams_chat_id',
                value: '={{ $json.body.data?.teams_chat_id || $json.body.teams_chat_id || "" }}',
                type: 'string',
              },
              {
                id: 'r4',
                name: 'account_id',
                value: accountId,
                type: 'string',
              },
            ],
          },
          options: {},
        },
        position: [500, 300],
        id: 'set1',
      },
      {
        name: 'Send to Teams',
        type: 'n8n-nodes-base.microsoftTeams',
        typeVersion: 2,
        parameters: {
          resource: 'chatMessage',
          operation: 'create',
          chatId: '={{ $json.teams_chat_id }}',
          messageType: 'text',
          message: '={{ $json.reply_text }}',
        },
        credentials: {
          microsoftTeamsOAuth2Api: {
            id: TEAMS_CREDENTIAL_ID,
            name: TEAMS_CREDENTIAL_NAME,
          },
        },
        position: [750, 300],
        id: 'ms1',
      },
      {
        name: 'Confirm to Portal',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: 'POST',
          url: `${PORTAL_URL}/api/webhooks/teams-reply`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'X-Webhook-Secret', value: WEBHOOK_SECRET },
            ],
          },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ conversation_id: $json.conversation_id, reply_text: $json.reply_text, account_id: $json.account_id }) }}',
          options: { timeout: 30000 },
        },
        position: [1000, 300],
        id: 'hp2',
      },
      {
        name: 'Respond OK',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1,
        parameters: {
          respondWith: 'json',
          responseBody: '={"success":true,"message_sent":true}',
          options: { responseCode: 200 },
        },
        position: [1250, 300],
        id: 'rw1',
      },
    ],
    connections: {
      'Portal Webhook': {
        main: [[{ node: 'Extract Reply Data', type: 'main', index: 0 }]],
      },
      'Extract Reply Data': {
        main: [[{ node: 'Send to Teams', type: 'main', index: 0 }]],
      },
      'Send to Teams': {
        main: [[{ node: 'Confirm to Portal', type: 'main', index: 0 }]],
      },
      'Confirm to Portal': {
        main: [[{ node: 'Respond OK', type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
    },
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Teams Integration Setup ===\n')

  // Step 1: Create Teams accounts in Supabase
  console.log('STEP 1: Creating Teams accounts in Supabase...')
  const teamAccounts = {}

  for (const company of COMPANIES) {
    // Check if Teams account already exists
    const { data: existing } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('name', `${company} Teams`)
      .eq('channel_type', 'teams')
      .maybeSingle()

    if (existing) {
      console.log(`  [SKIP] ${company} Teams — already exists (${existing.id})`)
      teamAccounts[company] = existing.id
      continue
    }

    const { data: account, error } = await supabase
      .from('accounts')
      .insert({
        name: `${company} Teams`,
        channel_type: 'teams',
        is_active: true,
        phase1_enabled: true,
        phase2_enabled: true,
        ai_auto_reply: false,
        ai_trust_mode: false,
        ai_confidence_threshold: 0.75,
        sla_warning_hours: 2,
        sla_critical_hours: 4,
        sla_auto_escalate: true,
      })
      .select('id')
      .single()

    if (error) {
      console.error(`  [ERROR] ${company} Teams: ${error.message}`)
      continue
    }

    console.log(`  [OK] ${company} Teams → ${account.id}`)
    teamAccounts[company] = account.id
  }

  console.log(`\n  Created ${Object.keys(teamAccounts).length} Teams accounts.\n`)

  // Step 2: Create Monitor workflows in n8n
  console.log('STEP 2: Creating Teams Monitor workflows in n8n...')
  const monitorWorkflowIds = {}

  for (const company of COMPANIES) {
    const accountId = teamAccounts[company]
    if (!accountId) {
      console.log(`  [SKIP] ${company} — no account ID`)
      continue
    }

    try {
      const workflow = buildTeamsMonitorWorkflow(company, accountId)
      const created = await n8nPost('/workflows', workflow)
      console.log(`  [OK] ${company} - Teams Monitor → ${created.id}`)
      monitorWorkflowIds[company] = created.id

      // Transfer to Unified Communication Portal project
      try {
        await n8nPut(`/workflows/${created.id}/transfer`, {
          destinationProjectId: N8N_PROJECT_ID,
        })
        console.log(`       → Moved to "Unified Communication Portal" project`)
      } catch (transferErr) {
        console.warn(`       → Transfer failed: ${transferErr.message}`)
      }
    } catch (err) {
      console.error(`  [ERROR] ${company}: ${err.message}`)
    }
  }

  // Step 3: Create Reply workflows in n8n
  console.log('\nSTEP 3: Creating Teams Reply workflows in n8n...')
  const replyWorkflowIds = {}

  for (const company of COMPANIES) {
    const accountId = teamAccounts[company]
    if (!accountId) {
      console.log(`  [SKIP] ${company} — no account ID`)
      continue
    }

    try {
      const workflow = buildTeamsReplyWorkflow(company, accountId)
      const created = await n8nPost('/workflows', workflow)
      console.log(`  [OK] ${company} - Teams Reply → ${created.id}`)
      replyWorkflowIds[company] = created.id

      // Transfer to Unified Communication Portal project
      try {
        await n8nPut(`/workflows/${created.id}/transfer`, {
          destinationProjectId: N8N_PROJECT_ID,
        })
        console.log(`       → Moved to "Unified Communication Portal" project`)
      } catch (transferErr) {
        console.warn(`       → Transfer failed: ${transferErr.message}`)
      }
    } catch (err) {
      console.error(`  [ERROR] ${company}: ${err.message}`)
    }
  }

  // Step 4: Update Supabase accounts with monitor workflow IDs
  console.log('\nSTEP 4: Updating accounts with n8n workflow IDs...')
  for (const company of COMPANIES) {
    const accountId = teamAccounts[company]
    const monitorId = monitorWorkflowIds[company]
    if (!accountId || !monitorId) continue

    const { error } = await supabase
      .from('accounts')
      .update({ make_scenario_id: monitorId })
      .eq('id', accountId)

    if (error) {
      console.error(`  [ERROR] ${company}: ${error.message}`)
    } else {
      console.log(`  [OK] ${company} Teams → make_scenario_id = ${monitorId}`)
    }
  }

  // Summary
  console.log('\n=== Summary ===')
  console.log(`\nTeams Accounts Created:`)
  for (const [company, id] of Object.entries(teamAccounts)) {
    console.log(`  ${company.padEnd(20)} → ${id}`)
  }
  console.log(`\nMonitor Workflows (n8n):`)
  for (const [company, id] of Object.entries(monitorWorkflowIds)) {
    console.log(`  ${company.padEnd(20)} → ${id}`)
  }
  console.log(`\nReply Workflows (n8n):`)
  for (const [company, id] of Object.entries(replyWorkflowIds)) {
    console.log(`  ${company.padEnd(20)} → ${id} (webhook: /webhook/teams-reply-${slug(company)})`)
  }

  console.log('\n=== NEXT STEPS ===')
  console.log('1. Open each Monitor workflow in n8n → select the Team & Channel to monitor')
  console.log('2. Activate all 20 workflows in n8n')
  console.log('3. Test: send a message in Teams → it should appear in the portal inbox')
  console.log('4. Test: approve an AI reply in the portal → it should send to Teams')
}

main().catch(console.error)
