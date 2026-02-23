import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import xlsx from "xlsx";
import sgMail from "@sendgrid/mail";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/** Download a URL (Tally private URL with token) to /tmp */
async function downloadToTmp(fileUrl, filename) {
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Download failed ${resp.status}: ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const filePath = path.join("/tmp", filename);
  await fs.writeFile(filePath, buf);
  return filePath;
}

/** Download Supabase Storage file to /tmp */
async function downloadPricebookToTmp(supabase) {
  const { data, error } = await supabase.storage.from("pricebooks").download("active.xlsx");
  if (error) throw error;

  const arrayBuffer = await data.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const tmpPath = path.join("/tmp", "pricebook.xlsx");
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

/** Load PRICEBOOK + ALIASES TABLE into lookup maps */
function loadPricebookAndAliases(pricebookPath) {
  const wb = xlsx.readFile(pricebookPath);

  const pbSheet = wb.Sheets["PRICEBOOK"];
  const aliasSheet = wb.Sheets["ALIASES TABLE"];
  if (!pbSheet) throw new Error("PRICEBOOK sheet not found in active.xlsx");
  if (!aliasSheet) throw new Error("ALIASES TABLE sheet not found in active.xlsx");

  const pricebookRows = xlsx.utils.sheet_to_json(pbSheet, { defval: "" });
  const aliasRows = xlsx.utils.sheet_to_json(aliasSheet, { defval: "" });

  const pbById = new Map();
  for (const row of pricebookRows) {
    const id = String(row["ITEM ID"] || row["ITEMID"] || "").trim();
    if (!id) continue;
    pbById.set(id, row);
  }

  const aliasMap = [];
  for (const a of aliasRows) {
    // Adjust these keys if your alias sheet uses different column names
    const aliasText = String(
      a["ALIAS"] || a["Alias"] || a["ALIAS TEXT"] || a["AliasText"] || ""
    )
      .trim()
      .toLowerCase();

    const itemId = String(a["ITEM ID"] || a["ITEMID"] || a["ItemID"] || "").trim();

    if (!aliasText || !itemId) continue;
    aliasMap.push({ aliasText, itemId });
  }

  // Match longer aliases first
  aliasMap.sort((x, y) => y.aliasText.length - x.aliasText.length);

  return { pbById, aliasMap };
}

/** Simple substring alias matching */
function matchItemIdByAlias(aliasMap, text) {
  const t = (text || "").toLowerCase();
  for (const a of aliasMap) {
    if (t.includes(a.aliasText)) return a.itemId;
  }
  return null;
}

/** OpenAI: extract repair items as strict JSON {items:[{text,qty}]} */
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
          {
            type: "input_text",
            text:
              "You are extracting repair/defect items from a BINSR or home inspection report. " +
              "Return only items that require repair/correction. " +
              "Keep each item concise. If quantity is unclear, set qty=1. " +
              "Do not include general disclaimers, maintenance tips, or purely informational notes.",
          },
          {
            type: "input_file",
            filename: path.basename(pdfPath),
            file_data: base64,
          },
        ],
      },
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
                properties: {
                  text: { type: "string" },
                  qty: { type: "number" },
                },
                required: ["text", "qty"],
                additionalProperties: false,
              },
            },
          },
          required: ["items"],
          additionalProperties: false,
        },
      },
    },
  });

  const parsed = JSON.parse(response.output_text || "{}");
  return parsed.items || [];
}

/** Build a simple PDF estimate buffer */
function buildEstimatePdf({ job, lines, totals }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text("BINSR PROS — Repair Estimate");
    doc.moveDown(0.5);

    doc.fontSize(10).text(`Estimate ID: ${job.id}`);
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.text(`Agent: ${job.name || ""}  |  ${job.email || ""}`);
    if (job.phone) doc.text(`Phone: ${job.phone}`);
    if (job.notes) doc.text(`Notes: ${job.notes}`);
    doc.moveDown();

    doc.fontSize(12).text("Scope & Pricing");
    doc.moveDown(0.5);

    doc.fontSize(10);
    if (!lines.length) {
      doc.text("No line items could be auto-matched from the uploaded report.");
      doc.text("We will review the report and follow up with an updated estimate within 24 hours.");
      doc.moveDown();
    } else {
      for (const ln of lines) {
        doc.text(`${ln.itemId} — ${ln.itemName}`);
        doc.text(
          `Qty: ${ln.qty}  Unit: ${ln.unit}  Unit Price: $${ln.unitPrice.toFixed(2)}  Line: $${ln.lineTotal.toFixed(
            2
          )}`
        );
        if (ln.description) doc.text(`Scope: ${ln.description}`);
        doc.moveDown(0.6);
      }
    }

    doc.moveDown(0.5);
    doc.fontSize(12).text("Totals");
    doc.fontSize(10);
    doc.text(`Repairs Subtotal: $${totals.subtotal.toFixed(2)}`);
    doc.text(`Tax: $${totals.tax.toFixed(2)}`);
    doc.text(`Trip Fee: $${totals.tripFee.toFixed(2)}`);
    doc.fontSize(12).text(`Total: $${totals.total.toFixed(2)}`);

    doc.end();
  });
}

export default async function handler(req, res) {
  try {
    // Validate required env vars
    const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "SENDGRID_API_KEY", "FROM_EMAIL"];
    for (const k of required) {
      if (!process.env[k]) return res.status(500).json({ ok: false, error: `Missing env var ${k}` });
    }

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 1) Get oldest queued job
    const { data: jobs, error: qErr } = await supabase
      .from("estimate_jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1);

    if (qErr) throw qErr;
    if (!jobs?.length) return res.status(200).json({ ok: true, message: "No queued jobs" });

    const job = jobs[0];

    // 2) Mark processing
    await supabase.from("estimate_jobs").update({ status: "processing", error: null }).eq("id", job.id);

    // 3) Choose BINSR if present else Inspection
    const sourceUrl = job.binsr_url || job.inspection_url;
    if (!sourceUrl) throw new Error("Job has no binsr_url or inspection_url");

    const reportPath = await downloadToTmp(sourceUrl, `report-${job.id}.pdf`);

    // 4) Download pricebook from Supabase Storage
    const pricebookPath = await downloadPricebookToTmp(supabase);

    // 5) Load pricebook + aliases
    const { pbById, aliasMap } = loadPricebookAndAliases(pricebookPath);

    // 6) Extract repair items with OpenAI
    const extracted = await extractRepairsWithOpenAI(reportPath);

    // 7) Match + price
    const lines = [];
    for (const it of extracted) {
      const rawText = it.text || "";
      const qty = Number(it.qty || 1) || 1;

      const itemId = matchItemIdByAlias(aliasMap, rawText);
      if (!itemId) continue; // MVP: skip unmatched (later: mark REVIEW)

      const pb = pbById.get(itemId);
      if (!pb) continue;

      const unitPrice = Number(pb["PRICE"] || pb["UNIT PRICE"] || pb["Unit Price"] || 0) || 0;
      const itemName = String(pb["ITEM NAME"] || pb["Item Name"] || "");
      const unit = String(pb["UNIT"] || "ea");
      const description = String(pb["ESTIMATE DESCRIPTION"] || pb["Estimate Description"] || "");

      lines.push({
        itemId,
        itemName,
        unit,
        qty,
        unitPrice,
        lineTotal: unitPrice * qty,
        description,
      });
    }

    // Totals (replace with tblSettings/tblTripFees later)
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const taxRate = 0.112;
    const tax = subtotal * taxRate;
    const tripFee = 0;
    const total = subtotal + tax + tripFee;

    // 8) Build PDF
    const pdfBuffer = await buildEstimatePdf({
      job,
      lines,
      totals: { subtotal, tax, tripFee, total },
    });

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
          disposition: "attachment",
        },
      ],
    });

    // 10) Mark done
    await supabase.from("estimate_jobs").update({ status: "done", result_pdf_url: null }).eq("id", job.id);

    return res.status(200).json({
      ok: true,
      processed: job.id,
      emailed: job.email,
      extractedCount: extracted.length,
      matchedLineCount: lines.length,
      total: Number(total.toFixed(2)),
    });
  } catch (err) {
    console.error("process-job error:", err);

    // Best-effort: mark the oldest processing job as failed (optional)
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: processing } = await supabase
        .from("estimate_jobs")
        .select("id")
        .eq("status", "processing")
        .order("created_at", { ascending: true })
        .limit(1);

      if (processing?.length) {
        await supabase
          .from("estimate_jobs")
          .update({ status: "failed", error: err?.message || "Server error" })
          .eq("id", processing[0].id);
      }
    } catch {}

    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
