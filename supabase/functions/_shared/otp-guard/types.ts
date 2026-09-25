export type Env = (key: string) => string | undefined

export type RpcResult = { data: unknown; error: unknown }

/** Calls a Postgres function with the service role. Implementations apply a timeout. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>

export type Logger = {
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export type Decision = {
  allowed: boolean
  reason: string | null
  retryAfter: number
  data: Record<string, unknown>
}
