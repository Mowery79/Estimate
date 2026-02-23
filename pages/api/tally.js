// pages/api/tally.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Always acknowledge Tally immediately
  res.status(200).json({ ok: true });

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const fields = req.body?.data?.fields || [];
    const byLabel = (label) =>
      fields.find((f) => (f?.label || "").toLowerCase() === label.toLowerCase());

    const firstName = byLabel("First Name")?.value || "";
    const lastName = byLabel("Last Name")?.value || "";
    const email = byLabel("Email")?.value || "";
    const phone = byLabel("Phone")?.value || "";
    const notes = byLabel("Additional Information")?.value || "";

    const binsrUrl = ((byLabel("BINSR")?.value || [])[0] || {})?.url || null;
    const inspectionUrl = ((byLabel("Inspection Report")?.value || [])[0] || {})?.url || null;

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
        inspection_url: inspectionUrl,
      })
      .select("id")
      .single();

    console.log("Supabase insert result:", { data, error });

    if (error) {
      console.error("Supabase insert error:", error);
      return;
    }

    console.log("✅ Queued estimate job:", data.id, email);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
}
