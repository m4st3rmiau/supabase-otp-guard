// Deploy without JWT verification: Auth authenticates hooks with a Standard Webhooks
// signature, which the handler verifies.
//   supabase functions deploy before-user-created-hook --no-verify-jwt
//
// Secret: BEFORE_USER_CREATED_HOOK_SECRET (v1,whsec_... shown when enabling the hook).
import { createLogger } from "../_shared/otp-guard/log.ts"
import { serviceRpc } from "../_shared/otp-guard/supabase.ts"
import { customSignupCheck } from "./extensions.ts"
import { createSignupHandler } from "./handler.ts"

Deno.serve(createSignupHandler({
  env: key => Deno.env.get(key),
  rpc: serviceRpc(),
  log: createLogger("before-user-created-hook"),
  customCheck: customSignupCheck,
}))
