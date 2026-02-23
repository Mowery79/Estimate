import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const fields = req.body?.data?.fields || [];
    const byLabel = (label) =>
      fields.find((f) => (f?.label || "").toLowerCase() === label.toLowerCase());

    const firstName = byLabel("First Name")?.value || "";
    const lastName = byLabel("Last Name")?.value || "";
    const email = byLabel("Email")?.value || "";
    const phone = byLabel("Phone")?.value || "";
    const notes = byLabel("Additional Information")?.value || "";

    const binsrUrl = ((byLabel("BINSR")?.value || [])[0] || {})?.url || null;
    const inspUrl = ((byLabel("Inspection Report")?.value || [])[0] || {})?.url || null;

    const { data, error } = await supabase
      .from("estimate_jobs")
      .insert({
        status: "queued",
        email,
        name: `${firstName} ${lastName}`.trim(),
        phone,
        notes,
        binsr_url: binsrUrl,
        inspection_url: inspUrl,
      })
      .select("id")
      .single();

    if (error) throw error;

    console.log("Queued job:", data.id, email);
    return res.status(200).json({ ok: true, job_id: data.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
