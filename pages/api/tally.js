// pages/api/tally.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // ✅ Browsers hit this with GET — always return 405
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    // ✅ Validate env vars (prevents confusing 500s)
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing env vars:", {
        hasSUPABASE_URL: !!supabaseUrl,
        hasSUPABASE_SERVICE_ROLE_KEY: !!supabaseKey,
      });
      return res
        .status(500)
        .json({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    // ✅ Create Supabase client INSIDE handler (prevents GET 500)
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Tally payload structure: req.body.data.fields[]
    const fields = req.body?.data?.fields || [];
    const byLabel = (label) =>
      fields.find((f) => (f?.label || "").toLowerCase() === label.toLowerCase());

    const firstName = byLabel("First Name")?.value || "";
    const lastName = byLabel("Last Name")?.value || "";
    const email = byLabel("Email")?.value || "";
    const phone = byLabel("Phone")?.value || "";
    const notes = byLabel("Additional Information")?.value || "";

    const binsrFile = (byLabel("BINSR")?.value || [])[0] || null;
    const inspFile = (byLabel("Inspection Report")?.value || [])[0] || null;

    const binsrUrl = binsrFile?.url || null;
    const inspectionUrl = inspFile?.url || null;

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing Email field" });
    }
    if (!binsrUrl && !inspectionUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing uploads (BINSR or Inspection Report)" });
    }

    const { data, error } = await supabase
      .from("estimate_jobs")
      .insert({
        status: "queued",
        email,
        name: `${firstName} ${lastName}`.trim(),
        phone,
        notes,
        binsr_url: binsrUrl,
        inspection_url: inspectionUrl,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      throw error;
    }

    console.log("Queued estimate job:", data.id, email);

    return res.status(200).json({ ok: true, job_id: data.id });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
