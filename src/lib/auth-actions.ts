'use server'

import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export async function signIn(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  const supabase = await createServerSupabaseClient()

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return { error: error.message }
  }

  redirect('/dashboard')
}

export async function signUp(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const fullName = formData.get('fullName') as string

  const supabase = await createServerSupabaseClient()

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
      },
    },
  })

  if (error) {
    return { error: error.message }
  }

  // public.users is created by the `on_auth_user_created` trigger, which also
  // promotes the very first signup to 'admin'. We only need to set full_name here.
  if (data.user && fullName) {
    try {
      const { createServiceRoleClient } = await import('@/lib/supabase-server')
      const serviceClient = await createServiceRoleClient()
      await serviceClient.from('users').update({ full_name: fullName }).eq('id', data.user.id)
    } catch (err) {
      console.error('Failed to set full_name on public.users:', err)
    }
  }

  redirect('/login?message=Account created! You can now sign in.')
}

export async function signOut() {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  redirect('/login')
}
