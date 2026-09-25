// Minimal Cloudflare Turnstile helper for the phone form. Render the widget once, then
// ask for a fresh token right before every send: tokens are single use, and the gateway
// rejects a reused one.
//
//   <div ref={container} />
//   const turnstile = await mountTurnstile(container.current!, process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!)
//   const token = await turnstile.token()
//   await supabase.auth.signInWithOtp({ phone, options: { captchaToken: token } })

type TurnstileApi = {
  render(element: HTMLElement, options: Record<string, unknown>): string
  execute(widgetId: string): void
  reset(widgetId: string): void
  remove(widgetId: string): void
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT
    script.async = true
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile unavailable"))
    script.onerror = () => reject(new Error("Turnstile failed to load"))
    document.head.appendChild(script)
  })
}

export async function mountTurnstile(element: HTMLElement, siteKey: string, action = "login") {
  const api = await loadScript()
  let pending: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null
  const widgetId = api.render(element, {
    sitekey: siteKey,
    action, // must be listed in OTP_GUARD_TURNSTILE_ACTIONS if you set it
    execution: "execute",
    callback: (token: string) => pending?.resolve(token),
    "error-callback": () => pending?.reject(new Error("Turnstile challenge failed")),
  })

  return {
    token(): Promise<string> {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        api.reset(widgetId) // a used token cannot be sent again
        api.execute(widgetId)
      })
    },
    remove() {
      api.remove(widgetId)
    },
  }
}
