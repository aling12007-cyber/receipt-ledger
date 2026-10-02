// GET /api/config — gives the browser the public Supabase settings and whether Claude reading is on.
// The anon key is designed to be public; row-level security in schema.sql protects the data.
// Without ANTHROPIC_API_KEY the site reads receipts on the user's own device for free (ocr.js).
// Values are trimmed: a stray space or newline pasted into Vercel would otherwise break sign-in.
const env = (k) => String(process.env[k] || "").trim();
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    supabaseUrl: env("SUPABASE_URL"),
    supabaseAnonKey: env("SUPABASE_ANON_KEY"),
    aiEnabled: Boolean(env("ANTHROPIC_API_KEY")),
    // Google Drive import (optional). These are public identifiers, restricted to this site in Google Cloud.
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleApiKey: env("GOOGLE_API_KEY"),
    googleAppId: env("GOOGLE_APP_ID"),
  });
}
