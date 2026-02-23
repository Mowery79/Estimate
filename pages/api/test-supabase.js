import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from("estimate_jobs")
      .insert({
        status: "queued",
        email: "test@example.com",
        name: "Test Job",
        notes: "Created from /api/test-supabase"
      })
      .select("*")
      .single();

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ ok: false, error });
    }

    return res.status(200).json({ ok: true, inserted: data });
  } catch (e) {
    console.error("Server error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}
