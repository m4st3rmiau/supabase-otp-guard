// Expo / React Native client. Native requests carry no Origin header, which is how the
// gateway tells them apart from browsers. No captcha on this path; see
// docs/threat-model.md.
import "react-native-url-polyfill/auto"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { createClient } from "@supabase/supabase-js"
import { createDeviceId, createOtpGuardFetch } from "@otp-guard/client"

const url = process.env.EXPO_PUBLIC_SUPABASE_URL!
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!

// One random ID per installation. AsyncStorage survives app updates and is cleared on
// uninstall, which is the lifetime otp-guard expects.
const getDeviceId = createDeviceId({
  get: key => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
})

export const supabase = createClient(url, anonKey, {
  auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  global: {
    fetch: createOtpGuardFetch({ supabaseUrl: url, platform: "mobile", getDeviceId }),
  },
})

// Unchanged app code:
//   await supabase.auth.signInWithOtp({ phone: "+525512345678" })
//   await supabase.auth.verifyOtp({ phone: "+525512345678", token, type: "sms" })
