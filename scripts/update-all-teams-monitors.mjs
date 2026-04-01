#!/usr/bin/env node
/**
 * Updates all 9 remaining Teams Monitor workflows with the working pattern:
 * Teams Trigger (newChatMessage) → Fetch Latest Message (Graph API) → Parse & Filter → Send to Portal
 *
 * Also updates all 10 Reply workflows to use the n8n Microsoft Teams node correctly.
 */

const N8N_BASE_URL = 'https://mcmflow.app.n8n.cloud'
const N8N_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MTU4ZmM1MC05NTVhLTRiOTAtODA0OC1mYzNkOGZlYTgzZjUiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMjgxNDIwNzItZDgwYi00YjAxLWFhNDktYzRkMDY1OGYwMzIwIiwiaWF0IjoxNzczOTk4MjQ1fQ.5kD4PR6AUbCijxwkn9U3D_fm3wG9HAfldC6qyTUUYQo'
const PORTAL_URL = 'https://unified-comm-portal.vercel.app'
const WEBHOOK_SECRET = 'my-webhook-secret-123'
const TEAMS_CRED_ID = '0lLW5CbkT2yJCDAB'
const TEAMS_CRED_NAME = 'Aman testing'

// All 10 monitor workflows with their account IDs
// Mycountrymobile is already fixed — skip it
const MONITOR_WORKFLOWS = [
  { workflowId: 'sucs1ZLEavpABdKb', company: 'Acepeak', accountId: '34e534a7-1c9e-490c-8dbb-439c70100a84' },
  { workflowId: 'iW0oDEwboQtNPdOq', company: 'Ajoxi', accountId: '25f5a260-5f11-4455-8f36-d51469f10d94' },
  { workflowId: 'S4zWnBefyxovZd7Y', company: 'Letsdial', accountId: '29990b03-d910-4239-a526-a6d8a4f15097' },
  { workflowId: 'u4VjutmcPLFvASZa', company: 'Meratalk', accountId: '0d196b33-10b4-4379-bed6-baf2338f358e' },
  // cfdynMu1JeQ08F5S = Mycountrymobile — already fixed, skip
  { workflowId: 'bJmG3GrMBysUv6jV', company: 'Rozper', accountId: '34af951b-016d-4333-86c1-dfaa8fdd6d19' },
  { workflowId: 'habuxJINjsQRDxDF', company: 'Softtop', accountId: '339bd9da-d269-4d9e-ab3b-7c4e65d82b2b' },
  { workflowId: '6bte7CNp3SZcJuS8', company: 'Techopensystems', accountId: 'b9f831b9-b543-4fdd-a173-0e4dd637eb0b' },
  { workflowId: 'rKTNyqxKTvtE45wi', company: 'Teloz', accountId: '3de4b1cd-bf2c-49ef-b368-90a1a9a89b68' },
  { workflowId: 'nQvg9bZ2VstxiXOA', company: 'Twiching', accountId: '0b27be5c-4799-4da7-adde-afe967420647' },
]

// All 10 reply workflows
const REPLY_WORKFLOWS = [
  { workflowId: 'kydvKcgqfFNMwYTx', company: 'Acepeak', accountId: '34e534a7-1c9e-490c-8dbb-439c70100a84' },
  { workflowId: 'DbXYileeM8nLQaIu', company: 'Ajoxi', accountId: '25f5a260-5f11-4455-8f36-d51469f10d94' },
  { workflowId: '8iTSmTWnJe1mcCNc', company: 'Letsdial', accountId: '29990b03-d910-4239-a526-a6d8a4f15097' },
  { workflowId: '0xTkTPm5q0EMNwND', company: 'Meratalk', accountId: '0d196b33-10b4-4379-bed6-baf2338f358e' },
  { workflowId: 'IVQruTUb58BVy7cU', company: 'Mycountrymobile', accountId: '723d0a65-e6d7-4c4b-998a-edea742cabd5' },
  { workflowId: '4dUkf1A1cqOu7jwI', company: 'Rozper', accountId: '34af951b-016d-4333-86c1-dfaa8fdd6d19' },
  { workflowId: 'CyH5znGNNpOGALgp', company: 'Softtop', accountId: '339bd9da-d269-4d9e-ab3b-7c4e65d82b2b' },
  { workflowId: '0CO26rV8WBv1U24J', company: 'Techopensystems', accountId: 'b9f831b9-b543-4fdd-a173-0e4dd637eb0b' },
  { workflowId: 'c9z9Pao8ixiMqS5b', company: 'Teloz', accountId: '3de4b1cd-bf2c-49ef-b368-90a1a9a89b68' },
  { workflowId: 'mZGUyiGM1OlmpcG4', company: 'Twiching', accountId: '0b27be5c-4799-4da7-adde-afe967420647' },
]

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function n8nPut(path, body) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method: 'PUT',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`PUT ${path} failed (${res.status}): ${text.substring(0, 200)}`)
  }
  return res.json()
}

async function n8nPost(path) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
  })
  // Activate/deactivate may return empty body
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { ok: res.ok } }
}

// ─── Build fixed Monitor workflow ────────────────────────────────────────────

function buildMonitorWorkflow(company, accountId) {
  return {
    name: `${company} - Teams Monitor`,
    nodes: [
      {
        parameters: {
          event: 'newChat',
        },
        name: 'Teams Trigger',
        type: 'n8n-nodes-base.microsoftTeamsTrigger',
        typeVersion: 1,
        position: [256, 304],
        id: 'tt1',
        credentials: {
          microsoftTeamsOAuth2Api: { id: TEAMS_CRED_ID, name: TEAMS_CRED_NAME },
        },
      },
      {
        parameters: {
          method: 'GET',
          url: `=https://graph.microsoft.com/v1.0/chats/\{\{ $json.id \}\}/messages?$top=1&$orderby=createdDateTime desc`,
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftTeamsOAuth2Api',
          options: {},
        },
        name: 'Fetch Latest Message',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [500, 304],
        id: 'fm1',
        credentials: {
          microsoftTeamsOAuth2Api: { id: TEAMS_CRED_ID, name: TEAMS_CRED_NAME },
        },
      },
      {
        parameters: {
          jsCode: `const response = $input.first().json;
const messages = response.value || [];
if (!messages.length) return [];

const msg = messages[0];

// Skip system/event messages
if (!msg || !msg.body || !msg.body.content) return [];
if (msg.messageType && msg.messageType !== 'message') return [];
// Skip bot/application messages
if (msg.from && msg.from.application) return [];

// Strip HTML
const text = (msg.body.content || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\\s+/g, ' ').trim();
if (!text || text.length < 2) return [];

return [{
  json: {
    account_id: '${accountId}',
    sender_name: msg.from?.user?.displayName || 'Unknown',
    sender_email: msg.from?.user?.email || msg.from?.user?.id || '',
    message_text: text,
    teams_message_id: msg.id || '',
    teams_chat_id: msg.chatId || $('Teams Trigger').first().json.id || '',
    timestamp: msg.createdDateTime || new Date().toISOString(),
    message_type: 'message'
  }
}];`,
        },
        name: 'Parse & Filter',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [740, 304],
        id: 'pf1',
      },
      {
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
        name: 'Send to Portal',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [980, 304],
        id: 'hp1',
      },
    ],
    connections: {
      'Teams Trigger': { main: [[{ node: 'Fetch Latest Message', type: 'main', index: 0 }]] },
      'Fetch Latest Message': { main: [[{ node: 'Parse & Filter', type: 'main', index: 0 }]] },
      'Parse & Filter': { main: [[{ node: 'Send to Portal', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  }
}

// ─── Build fixed Reply workflow ──────────────────────────────────────────────

function buildReplyWorkflow(company, accountId) {
  const s = slug(company)
  return {
    name: `${company} - Teams Reply`,
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: `teams-reply-${s}`,
          responseMode: 'lastNode',
          options: {},
        },
        name: 'Portal Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [250, 300],
        id: 'wh1',
        webhookId: `teams-reply-${s}`,
      },
      {
        parameters: {
          jsCode: `const body = $input.first().json.body || $input.first().json;
const data = body.data || body;

const replyText = data.reply_text || '';
const conversationId = data.conversation_id || '';
const chatId = data.teams_chat_id || '';

if (!replyText || !chatId) {
  return [{ json: { error: 'Missing reply_text or teams_chat_id', success: false } }];
}

return [{ json: { reply_text: replyText, conversation_id: conversationId, teams_chat_id: chatId, account_id: '${accountId}' } }];`,
        },
        name: 'Extract Reply Data',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [480, 300],
        id: 'er1',
      },
      {
        parameters: {
          method: 'POST',
          url: '=https://graph.microsoft.com/v1.0/chats/{{ $json.teams_chat_id }}/messages',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftTeamsOAuth2Api',
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ body: { contentType: "text", content: $json.reply_text } }) }}',
          options: {},
        },
        name: 'Send to Teams',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [720, 300],
        id: 'st1',
        credentials: {
          microsoftTeamsOAuth2Api: { id: TEAMS_CRED_ID, name: TEAMS_CRED_NAME },
        },
      },
      {
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
          jsonBody: `={{ JSON.stringify({ conversation_id: $('Extract Reply Data').first().json.conversation_id, reply_text: $('Extract Reply Data').first().json.reply_text, account_id: '${accountId}' }) }}`,
          options: { timeout: 30000 },
        },
        name: 'Confirm to Portal',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [960, 300],
        id: 'cp1',
      },
      {
        parameters: {
          mode: 'manual',
          duplicateItem: false,
          assignments: {
            assignments: [
              { id: 'r1', name: 'success', value: 'true', type: 'boolean' },
              { id: 'r2', name: 'message', value: 'Reply sent to Teams and confirmed to portal', type: 'string' },
            ],
          },
          options: {},
        },
        name: 'Respond OK',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [1200, 300],
        id: 'ro1',
      },
    ],
    connections: {
      'Portal Webhook': { main: [[{ node: 'Extract Reply Data', type: 'main', index: 0 }]] },
      'Extract Reply Data': { main: [[{ node: 'Send to Teams', type: 'main', index: 0 }]] },
      'Send to Teams': { main: [[{ node: 'Confirm to Portal', type: 'main', index: 0 }]] },
      'Confirm to Portal': { main: [[{ node: 'Respond OK', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Updating All Teams Workflows ===\n')

  // Update Monitor workflows
  console.log('--- MONITOR WORKFLOWS (9 remaining) ---')
  for (const wf of MONITOR_WORKFLOWS) {
    try {
      // Deactivate first
      await n8nPost(`/workflows/${wf.workflowId}/deactivate`)
      // Update
      const workflow = buildMonitorWorkflow(wf.company, wf.accountId)
      await n8nPut(`/workflows/${wf.workflowId}`, workflow)
      console.log(`  [OK] ${wf.company} - Teams Monitor (${wf.workflowId}) updated`)
    } catch (err) {
      console.error(`  [ERROR] ${wf.company}: ${err.message}`)
    }
  }

  // Update Reply workflows (all 10 including Mycountrymobile)
  console.log('\n--- REPLY WORKFLOWS (all 10) ---')
  for (const wf of REPLY_WORKFLOWS) {
    try {
      // Deactivate first
      await n8nPost(`/workflows/${wf.workflowId}/deactivate`)
      // Update
      const workflow = buildReplyWorkflow(wf.company, wf.accountId)
      await n8nPut(`/workflows/${wf.workflowId}`, workflow)
      // Activate
      await n8nPost(`/workflows/${wf.workflowId}/activate`)
      console.log(`  [OK] ${wf.company} - Teams Reply (${wf.workflowId}) updated & activated`)
    } catch (err) {
      console.error(`  [ERROR] ${wf.company}: ${err.message}`)
    }
  }

  console.log('\n=== All workflows updated ===')
  console.log('Monitor workflows left inactive — activate after setting Team/Channel in n8n UI')
  console.log('Reply workflows activated — ready to receive approved replies from portal')
}

main().catch(console.error)
