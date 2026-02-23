// pages/api/tally.js
import fs from "fs/promises";
import path from "path";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const payload = req.body;
    const fields = payload?.data?.fields || [];

    // Helper: find a field by label
    const byLabel = (label) =>
      fields.find((f) => (f?.label || "").toLowerCase() === label.toLowerCase());

    const firstName = byLabel("First Name")?.value || "";
    const lastName = byLabel("Last Name")?.value || "";
    const email = byLabel("Email")?.value || "";
    const phone = byLabel("Phone")?.value || "";
    const notes = byLabel("Additional Information")?.value || "";

    // File fields come through as arrays
    const binsrFile = (byLabel("BINSR")?.value || [])[0];
    const inspFile = (byLabel("Inspection Report")?.value || [])[0];

    const binsrUrl = binsrFile?.url || null;
    const inspUrl = inspFile?.url || null;

    if (!email || (!binsrUrl && !inspUrl)) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: email and at least one uploaded file (BINSR or Inspection Report).",
      });
    }

    // Download helper (Tally URLs already include accessToken/signature)
    async function downloadToTmp(fileUrl, filename) {
      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error(`Download failed ${resp.status}: ${resp.statusText}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const filePath = path.join("/tmp", filename);
      await fs.writeFile(filePath, buf);
      return filePath;
    }

    const downloads = [];
    if (binsrUrl) downloads.push(downloadToTmp(binsrUrl, "binsr.pdf"));
    if (inspUrl) downloads.push(downloadToTmp(inspUrl, "inspection.pdf"));

    const savedPaths = await Promise.all(downloads);

    console.log("Tally submission received:", {
      name: `${firstName} ${lastName}`.trim(),
      email,
      phone,
      notes,
      savedPaths,
      hasBinsr: !!binsrUrl,
      hasInspection: !!inspUrl,
    });

    // ✅ NEXT (coming right after this):
    // - load your Price Book XLSX
    // - call OpenAI to extract repair items from the PDF(s)
    // - match items via aliases/pricebook
    // - generate estimate PDF
    // - email to `email`

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
