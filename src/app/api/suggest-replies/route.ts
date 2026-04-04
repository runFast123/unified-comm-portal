import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { callAI } from '@/lib/api-helpers'

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { conversation_id, message_text, category } = await request.json()
    if (!conversation_id || !message_text) {
      return NextResponse.json({ error: 'Missing conversation_id or message_text' }, { status: 400 })
    }

    // Generate 3 short suggested replies using AI
    const prompt = `You are a customer support assistant. Based on the customer's message, generate exactly 3 short, professional reply options. Each should be 1-2 sentences max. Return ONLY a JSON array of 3 strings, no markdown.

Customer message: "${message_text.substring(0, 300)}"
${category ? `Category: ${category}` : ''}

Example output: ["Thank you for reaching out. I'll look into this right away.", "I understand your concern. Let me check with our team and get back to you.", "Thanks for the information. Could you provide more details about your requirements?"]`

    const aiResponse = await callAI(prompt, 'Generate 3 suggested replies as a JSON array.')

    let suggestions: string[] = []
    try {
      const match = aiResponse.match(/\[[\s\S]*\]/)
      if (match) suggestions = JSON.parse(match[0])
    } catch {
      suggestions = ['Thank you for reaching out. How can I help you?', 'I\'ll look into this and get back to you shortly.', 'Could you provide more details so I can assist you better?']
    }

    // Also fetch matching templates
    const { data: templates } = await supabase
      .from('reply_templates')
      .select('id, title, content')
      .eq('is_active', true)
      .order('usage_count', { ascending: false })
      .limit(3)

    return NextResponse.json({
      ai_suggestions: suggestions.slice(0, 3),
      templates: (templates || []).map((t: any) => ({ id: t.id, title: t.title, content: t.content })),
    })
  } catch (error) {
    console.error('Suggest replies error:', error)
    return NextResponse.json({ error: 'Failed to generate suggestions' }, { status: 500 })
  }
}
