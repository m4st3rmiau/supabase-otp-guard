// The only module that talks to Supabase directly. Handlers receive `Rpc` instead, so
// they can be tested without Deno or a network.
import { createClient } from "npm:@supabase/supabase-js@2"
import type { Rpc } from "./types.ts"

const RPC_TIMEOUT_MS = 2500

export function serviceRpc(): Rpc {
  const url = Deno.env.get("SUPABASE_URL")
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!url || !key) {
    return () => Promise.resolve({ data: null, error: new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing") })
  }
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
    return { data, error }
  }
}
