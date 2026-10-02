// GET /api/config — gives the browser the public Supabase settings.
// The anon key is designed to be public; row-level security in schema.sql protects the data.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
}
