// pages/api/process-job.js
export const config = { runtime: "nodejs" };
import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import xlsx from "xlsx";
import sgMail from "@sendgrid/mail";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/**
 * ================
 * Helpers: Downloads
 * ================
 */
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

/**
 * ==========================
 * Helpers: Sheet/tab detection
 * ==========================
 * This makes the code resilient to:
 * - casing differences ("Pricebook" vs "PRICEBOOK")
 * - trailing/leading whitespace ("PRICEBOOK ")
 * - hidden unicode whitespace
 */
function normName(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getSheetByNameLoose(wb, wanted) {
  const target = normName(wanted);
  const matchName = wb.SheetNames.find((n) => normName(n) === target);
  return matchName ? { name: matchName, sheet: wb.Sheets[matchName] } : null;
}

// Optional fallback: detect sheet by header keywords
function findSheetByHeaderHints(wb, requiredHintsLower) {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const header = (rows[0] || []).map((h) => normName(h));
    const ok = requiredHintsLower.every((h) => header.includes(normName(h)));
    if (ok) return { name, sheet: ws };
  }
  return null;
}

/**
 * ==========================
 * Helpers: Pricebook + Aliases
 * ==========================
 */
function loadPricebookAndAliases(pricebookPath) {
  const wb = xlsx.readFile(pricebookPath);

  // Try exact-ish names first (loose)
  let pbHit = getSheetByNameLoose(wb, "PRICEBOOK");
  let alHit = getSheetByNameLoose(wb, "ALIASES TABLE");

  // Fallback: detect by header hints
  if (!pbHit) {
    pbHit = findSheetByHeaderHints(wb, ["item id", "price"]);
  }
  if (!alHit) {
    alHit = findSheetByHeaderHints(wb, ["alias", "item id"]);
  }

  if (!pbHit) {
    throw new Error(
      `PRICEBOOK sheet not found. Found sheets: ${wb.SheetNames.join(", ")}`
    );
  }
  if (!alHit) {
    throw new Error(
      `ALIASES TABLE sheet not found. Found sheets: ${wb.SheetNames.join(", ")}`
    );
  }

  const pbRows = xlsx.utils.sheet_to_json(pbHit.sheet, { defval: "" });
  const aliasRows = xlsx.utils.sheet_to_json(alHit.sheet, { defval: "" });

  const pbById = new Map();
  for (const row of pbRows) {
    const id = String(row["ITEM ID"] || row["ITEMID"] || row["ItemID"] || "").trim();
    if (id) pbById.set(id, row);
  }

  const aliasMap = [];
  for (const a of aliasRows) {
    const aliasText = String(
      a["ALIAS"] ||
        a["Alias"] ||
        a["ALIAS TEXT"] ||
        a["AliasText"] ||
        a["ALIASTEXT"] ||
        ""
    )
      .trim()
      .toLowerCase();

    const itemId = String(a["ITEM ID"] || a["ITEMID"] || a["ItemID"] || "").trim();

    if (!aliasText || !itemId) continue;
    aliasMap.push({ aliasText, itemId });
  }

  // Prefer longer aliases first
  aliasMap.sort((x, y) => y.aliasText.length - x.aliasText.length);

  return {
    sheetNames: wb.SheetNames,
    pricebookSheetName: pbHit.name,
    aliasSheetName: alHit.name,
    pbById,
    aliasMap,
  };
}

function matchItemIdByAlias(aliasMap, text) {
  const t = (text || "").toLowerCase();
  for (const a of aliasMap) {
    if (t.includes(a.aliasText)) return a.itemId;
  }
  return null;
}

/**
 * ==========================
 * OpenAI: extract repair items
 * ==========================
 */
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
              "Extract repair/defect items from this BINSR or inspection report. " +
              "Return only items that require repair/correction. " +
              "Keep each item concise. If quantity is unclear, set qty=1. " +
              "Ignore general disclaimers and informational text.",
          },
          { type: "input_file", filename: path.basename(pdfPath), file_data: base64 },
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

/**
 * ==========================
 * PDF generation
 * ==========================
 */
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
    doc.text(`Agent: ${job.name || ""} | ${job.email || ""}`);
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
          `Qty: ${ln.qty}  Unit: ${ln.unit}  Unit Price: $${ln.unitPrice.toFixed(
            2
          )}  Line: $${ln.lineTotal.toFixed(2)}`
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

/**
 * ==========================
 * Main handler
 * ==========================
 */
export default async function handler(req, res) {
  try {
    // Required env vars
    const required = [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "OPENAI_API_KEY",
      "SENDGRID_API_KEY",
      "FROM_EMAIL",
    ];
    for (const k of required) {
      if (!process.env[k]) return res.status(500).json({ ok: false, error: `Missing env var ${k}` });
    }

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Get oldest queued job WITH at least one URL
    const { data: jobs, error: qErr } = await supabase
      .from("estimate_jobs")
      .select("*")
      .eq("status", "queued")
      .or("binsr_url.not.is.null,inspection_url.not.is.null")
      .order("created_at", { ascending: true })
      .limit(1);

    if (qErr) throw qErr;
    if (!jobs?.length) return res.status(200).json({ ok: true, message: "No queued jobs" });

    const job = jobs[0];

    // Mark processing
    await supabase.from("estimate_jobs").update({ status: "processing", error: null }).eq("id", job.id);

    // BINSR preferred else inspection
    const sourceUrl = job.binsr_url || job.inspection_url;
    if (!sourceUrl) {
      await supabase
        .from("estimate_jobs")
        .update({ status: "failed", error: "Missing binsr_url and inspection_url" })
        .eq("id", job.id);
      return res.status(200).json({ ok: true, skipped: job.id });
    }

    // Download report + pricebook
    const reportPath = await downloadToTmp(sourceUrl, `report-${job.id}.pdf`);
    const pricebookPath = await downloadPricebookToTmp(supabase);

    // Load pricebook + aliases with robust tab detection
    const { sheetNames, pricebookSheetName, aliasSheetName, pbById, aliasMap } =
      loadPricebookAndAliases(pricebookPath);

    // Extract repairs via OpenAI
    const extracted = await extractRepairsWithOpenAI(reportPath);

    // Match + price
    const lines = [];
    for (const it of extracted) {
      const rawText = it.text || "";
      const qty = Number(it.qty || 1) || 1;

      const itemId = matchItemIdByAlias(aliasMap, rawText);
      if (!itemId) continue;

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

    // Totals (swap in SETTINGS/TRIPFEES later)
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const taxRate = 0.112;
    const tax = subtotal * taxRate;
    const tripFee = 0;
    const total = subtotal + tax + tripFee;

    // Build PDF
    const pdfBuffer = await buildEstimatePdf({ job, lines, totals: { subtotal, tax, tripFee, total } });

    // Send email
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

    // Mark done
    await supabase.from("estimate_jobs").update({ status: "done", result_pdf_url: null }).eq("id", job.id);

    return res.status(200).json({
      ok: true,
      processed: job.id,
      emailed: job.email,
      extractedCount: extracted.length,
      matchedLineCount: lines.length,
      total: Number(total.toFixed(2)),
      pricebookSheetUsed: pricebookSheetName,
      aliasSheetUsed: aliasSheetName,
      sheetNamesFound: sheetNames,
    });
  } catch (err) {
    console.error("process-job error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
