// pages/api/tally.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Acknowledge Tally quickly
  res.status(200).json({ ok: true });

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing env vars:", {
        hasSUPABASE_URL: !!supabaseUrl,
        hasSUPABASE_SERVICE_ROLE_KEY: !!supabaseKey
      });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const fields = req.body?.data?.fields || [];
    const byLabel = (label) =>
      fields.find((f) => (f?.label || "").toLowerCase() === label.toLowerCase());

    const email = byLabel("Email")?.value || "";
    const firstName = byLabel("First Name")?.value || "";
    const lastName = byLabel("Last Name")?.value || "";
    const phone = byLabel("Phone")?.value || "";
    const notes = byLabel("Additional Information")?.value || "";

    // FILE_UPLOAD can be null
    const binsrVal = byLabel("BINSR")?.value;
    const inspVal = byLabel("Inspection Report")?.value;

    const binsrUrl = Array.isArray(binsrVal) ? binsrVal?.[0]?.url : null;
    const inspectionUrl = Array.isArray(inspVal) ? inspVal?.[0]?.url : null;

    console.log("Tally fields parsed:", { email, binsrUrl: !!binsrUrl, inspectionUrl: !!inspectionUrl });

    const { data, error } = await supabase
      .from("estimate_jobs")
      .insert({
        status: "queued",
        email,
        name: `${firstName} ${lastName}`.trim(),
        phone,
        notes,
        binsr_url: binsrUrl,
        inspection_url: inspectionUrl
      })
      .select("id")
      .single();

    console.log("Supabase insert result:", { data, error });
    if (error) console.error("Supabase insert error:", error);
  } catch (e) {
    console.error("tally endpoint error:", e);
  }
}
