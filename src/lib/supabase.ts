import { createClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

/**
 * The session is persisted and auto-refreshed so the app opens straight onto
 * Today. Re-authenticating on every launch would cost more than the ten
 * seconds the whole product is budgeted for.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})
