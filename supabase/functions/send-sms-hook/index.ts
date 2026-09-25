// Deploy without JWT verification: Auth authenticates hooks with a Standard Webhooks
// signature, which the handler verifies.
//   supabase functions deploy send-sms-hook --no-verify-jwt
//
// Secrets: SEND_SMS_HOOK_SECRET (v1,whsec_... shown when enabling the hook) and the
// provider's variables, see providers/bird.ts.
import { createLogger } from "../_shared/otp-guard/log.ts"
import { serviceRpc } from "../_shared/otp-guard/supabase.ts"
import { createSendSmsHandler } from "./handler.ts"
import { createBirdProvider } from "./providers/bird.ts"

const env = (key: string) => Deno.env.get(key)

Deno.serve(createSendSmsHandler({
  env,
  rpc: serviceRpc(),
  log: createLogger("send-sms-hook"),
  // Built per send so a missing secret is a logged 503, not a crashed function.
  provider: () => createBirdProvider(env, (input, init) => fetch(input, init)),
}))
