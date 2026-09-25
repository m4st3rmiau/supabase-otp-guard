// Deploy without JWT verification: the gateway is a public endpoint that does its own
// checks, and projects on publishable keys have no JWT to verify.
//   supabase functions deploy otp-gateway --no-verify-jwt
import { createLogger } from "../_shared/otp-guard/log.ts"
import { serviceRpc } from "../_shared/otp-guard/supabase.ts"
import { createGatewayHandler } from "./handler.ts"

Deno.serve(createGatewayHandler({
  env: key => Deno.env.get(key),
  rpc: serviceRpc(),
  fetch: (input, init) => fetch(input, init),
  log: createLogger("otp-gateway"),
}))
