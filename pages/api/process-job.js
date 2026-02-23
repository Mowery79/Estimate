import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import xlsx from "xlsx";
import sgMail from "@sendgrid/mail";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

async function downloadToTmp(fileUrl, filename) {
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Download failed ${resp.status}: ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const filePath = path.join("/tmp", filename);
  await fs.writeFile(filePath, buf);
  return filePath;
}

async function downloadPricebookToTmp(supabase) {
  const { data, error } = await supabase.storage.from("pricebooks").download("active.xlsx");
  if (error) throw error;

  const arrayBuffer = await data.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const tmpPath = path.join("/tmp", "pricebook.xlsx");
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

function loadPricebookAndAliases(pricebookPath) {
  const wb = xlsx.readFile(pricebookPath);

  const pbSheet = wb.Sheets["PRICEBOOK"];
  const aliasSheet = wb.Sheets["ALIASES TABLE"];

  if (!pbSheet) throw new Error("PRICEBOOK sheet not found in pricebook");
  if (!aliasSheet) throw new Error("ALIASES TABLE sheet not found in pricebook");

  const pricebook = xlsx.utils.sheet_to_json(pbSheet, { defval: "" });
  const aliases = xlsx.utils.sheet_to_json(aliasSheet, { defval: "" });

  const pbById = new Map();
  for (const row of pricebook) {
    const id = String(row["ITEM ID"] || row["ITEMID"] || "").trim();
    if (id) pbById.set(id, row);
  }

  const aliasMap = [];
  for (const a of aliases) {
    const aliasText = String(a["ALIAS"] || a["Alias"] || a["ALIAS TEXT"] || a["AliasText"] || "")
      .trim()
      .toLowerCase();
    const itemId = String(a["ITEM ID"] || a["ItemID"] || a["ITEMID"] || "").trim();
    if (aliasText && itemId) aliasMap.push({ aliasText, itemId });
  }

  aliasMap.sort((x, y) => y.aliasText.length - x.aliasText.length);
  return { pbById, aliasMap };
}

function matchItemIdByAlias(aliasMap, text) {
  const t = (text || "").toLowerCase();
  for (const a of aliasMap) if (t.includes(a.aliasText)) return a.itemId;
  return null;
}

async function extractRepairsWithOpenAI(pdfPath) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const pdfBytes = await fs.readFile(pdfPath);
  const base64 = pdfBytes.toString("base64");

  const response = await client.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract repair items only. Return each as {text, qty}. If qty unclear, qty=1." },
          { type: "input_file", filename: path.basename(pdfPath), file_data: base64 }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "repair_items",
        strict: true,
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { text: { type: "string" }, qty: { type: "number" } },
                required: ["text", "qty"],
                additionalProperties: false
              }
            }
          },
          required: ["items"],
          additionalProperties: false
        }
      }
    }
  });

  const parsed = JSON.parse(response.output_text || "{}");
  return parsed.items || [];
}

function buildEstimatePdf({ job, lines, totals }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text("BINSR PROS — Repair Estimate");
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`);
    doc.text(`Agent: ${job.name || ""} | ${job.email || ""}`);
    doc.moveDown();

    doc.fontSize(12).text("Scope & Pricing");
    doc.moveDown(0.5);

    doc.fontSize(10);
    for (const ln of lines) {
      doc.text(`${ln.itemId} — ${ln.itemName}`);
      doc.text(`Qty: ${ln.qty}  Unit Price: $${ln.unitPrice.toFixed(2)}  Line: $${ln.lineTotal.toFixed(2)}`);
      if (ln.description) doc.text(`Scope: ${ln.description}`);
      doc.moveDown(0.6);
    }

    doc.moveDown(0.5);
    doc.fontSize(12).text("Totals");
    doc.fontSize(10);
    doc.text(`Subtotal: $${totals.subtotal.toFixed(2)}`);
    doc.text(`Tax: $${totals.tax.toFixed(2)}`);
    doc.text(`Trip Fee: $${totals.tripFee.toFixed(2)}`);
    doc.fontSize(12).text(`Total: $${totals.total.toFixed(2)}`);
    doc.end();
  });
}

export default async function handler(req, res) {
  try {
    // Required env vars
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY" });
    if (!process.env.SENDGRID_API_KEY) return res.status(500).json({ ok: false, error: "Missing SENDGRID_API_KEY" });
    if (!process.env.FROM_EMAIL) return res.status(500).json({ ok: false, error: "Missing FROM_EMAIL" });

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 1) Get oldest queued job
    const { data: jobs, error } = await supabase
      .from("estimate_jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) throw error;
    if (!jobs?.length) return res.status(200).json({ ok: true, message: "No queued jobs" });

    const job = jobs[0];

    // 2) Mark processing
    await supabase.from("estimate_jobs").update({ status: "processing", error: null }).eq("id", job.id);

    // 3) Choose BINSR if present, else Inspection
    const sourceUrl = job.binsr_url || job.inspection_url;
    if (!sourceUrl) throw new Error("Job has no binsr_url or inspection_url");

    const reportPath = await downloadToTmp(sourceUrl, `report-${job.id}.pdf`);

    // 4) Download pricebook from Supabase Storage
    const pricebookPath = await downloadPricebookToTmp(supabase);

    // 5) Load pricebook + aliases
    const { pbById, aliasMap } = loadPricebookAndAliases(pricebookPath);

    // 6) Extract repair items (OpenAI)
    const extracted = await extractRepairsWithOpenAI(reportPath);

    // 7) Match + price
    const lines = [];
    for (const it of extracted) {
      const rawText = it.text || "";
      const qty = Number(it.qty || 1) || 1;

      const itemId = matchItemIdByAlias(aliasMap, rawText);
      if (!itemId) continue;

      const pb = pbById.get(itemId);
      if (!pb) continue;

      const unitPrice = Number(pb["PRICE"] || pb["UNIT PRICE"] || pb["Unit Price"] || 0) || 0;
      const itemName = String(pb["ITEM NAME"] || "");
      const description = String(pb["ESTIMATE DESCRIPTION"] || "");
      lines.push({
        itemId,
        itemName,
        qty,
        unitPrice,
        lineTotal: unitPrice * qty,
        description
      });
    }

    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const taxRate = 0.112;   // update later from tblSettings
    const tax = subtotal * taxRate;
    const tripFee = 0;       // update later from tblTripFees
    const total = subtotal + tax + tripFee;

    // 8) Build PDF
    const pdfBuffer = await buildEstimatePdf({ job, lines, totals: { subtotal, tax, tripFee, total } });

    // 9) Email via SendGrid
    await sgMail.send({
      to: job.email,
      from: process.env.FROM_EMAIL,
      subject: "Your BINSR PROS Instant Repair Estimate",
      text:
        "Attached is your BINSR PROS instant repair estimate.\n\n" +
        "We will review this estimate within 24 hours and update it if any revisions are needed.\n" +
        "This estimate provides a general idea of pricing based on the items provided.\n\n" +
        "Reply to this email if you have any questions.\n",
      attachments: [
        {
          content: pdfBuffer.toString("base64"),
          filename: `Estimate_${job.id}.pdf`,
          type: "application/pdf",
          disposition: "attachment"
        }
      ]
    });

    // 10) Mark done
    await supabase.from("estimate_jobs").update({ status: "done", result_pdf_url: null }).eq("id", job.id);

    return res.status(200).json({ ok: true, processed: job.id, emailed: job.email, lineCount: lines.length });
  } catch (err) {
    console.error("process-job error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
