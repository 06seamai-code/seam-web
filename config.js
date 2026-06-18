// Seam web app — public configuration (safe to ship; these are public keys).
window.SEAM_CONFIG = {
  SUPABASE_URL: "https://lzrgmaqnslwfvbfcysew.supabase.co",
  SUPABASE_KEY: "sb_publishable_VRTZbGfIrykn1I8nWPGCLw_0gZJxsj5",
  // The chat goes through the Edge Function so the Anthropic key stays secret.
  // This resolves to {SUPABASE_URL}/functions/v1/chat once you deploy it.
  CHAT_FUNCTION: "/functions/v1/chat",
};
