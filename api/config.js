// GET /api/config — gives the browser the public Supabase settings and whether Claude reading is on.
// The anon key is designed to be public; row-level security in schema.sql protects the data.
// Without ANTHROPIC_API_KEY the site reads receipts on the user's own device for free (ocr.js).
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
