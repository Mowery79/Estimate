// pages/api/process-job.js
//
// Processes ONE estimate job per request:
// - Claims a queued job (or reclaims stale processing/ai_started jobs)
// - Downloads PDFs (Tally URLs), extracts text via pdf-parse
// - Calls OpenAI Responses API using text.format JSON mode (no file_data)
// - Saves estimate_json + estimate_text
// - Sends email via SendGrid to customer AND a copy to BINSR@dignhomes.com
// - Updates status + timestamps + errors so jobs never get stuck
//
// REQUIRED Vercel env vars (set for the env you're testing: Production/Preview):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
//   SENDGRID_API_KEY
//   EMAIL_FROM              (e.g. "estimates@binsrpros.com")
// OPTIONAL:
//   STALE_MINUTES           (default 20)
//   OPENAI_TIMEOUT_MS       (default 90000)
//
// Dependencies:
//   npm i pdf-parse openai @supabase/supabase-js @sendgrid/mail

export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import pdf from "pdf-parse";
import sgMail from "@sendgrid/mail";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_PROMPT_CHARS = 120000;
const FETCH_TIMEOUT_MS = 30000;

const STALE_MINUTES = Number(process.env.STALE_MINUTES || 20);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);

const INTERNAL_COPY_EMAIL = "BINSR@dignhomes.com";

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function clampText(text, maxChars = MAX_PROMPT_CHARS) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[TRUNCATED]";
}

async function pdfTextFromUrl(url) {
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`Failed to fetch PDF (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const parsed = await pdf(buf);
  return parsed?.text || "";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function buildEmailHtml(job, estimate) {
  const items = Array.isArray(estimate?.line_items) ? estimate.line_items : [];
  const rows = items
    .slice(0, 60)
    .map((li) => {
      const name = li?.name ?? "";
      const qty = li?.qty ?? "";
      const unit = money(li?.unit_price);
      const total = money(li?.total);
      const desc = li?.description
        ? `<div style="color:#555;font-size:12px;margin-top:2px;">${escapeHtml(li.description)}</div>`
        : "";
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;">
            <strong>${escapeHtml(name)}</strong>${desc}
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(String(qty))}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(unit)}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(total)}</td>
        </tr>
      `;
    })
    .join("");

  const assumptions = Array.isArray(estimate?.assumptions) ? estimate.assumptions : [];
  const assumptionsHtml = assumptions.length
    ? `<ul style="margin:6px 0 0 18px;">${assumptions
        .slice(0, 20)
        .map((a) => `<li>${escapeHtml(String(a))}</li>`)
        .join("")}</ul>`
    : `<div style="color:#555;">None listed.</div>`;

  return `
  <div style="font-family:Arial,sans-serif;line-height:1.4;color:#111;">
    <h2 style="margin:0 0 8px;">BINSR Pros — Repair Estimate</h2>
    <div style="color:#555;margin-bottom:14px;">Job ID: ${escapeHtml(job.id)}</div>

    <h3 style="margin:18px 0 6px;">Summary</h3>
    <div style="white-space:pre-wrap;">${escapeHtml(String(estimate?.summary ?? ""))}</div>

    <h3 style="margin:18px 0 6px;">Line Items</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd;">Item</th>
          <th style="text-align:right;padding:8px;border-bottom:2px solid #ddd;">Qty</th>
          <th style="text-align:right;padding:8px;border-bottom:2px solid #ddd;">Unit</th>
          <th style="text-align:right;padding:8px;border-bottom:2px solid #ddd;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="4" style="padding:8px;color:#555;">No line items returned.</td></tr>`}
      </tbody>
    </table>

    <div style="margin-top:14px;text-align:right;">
      <div>Subtotal: <strong>${escapeHtml(money(estimate?.subtotal))}</strong></div>
      <div>Tax: <strong>${escapeHtml(money(estimate?.tax))}</strong></div>
      <div style="font-size:18px;margin-top:6px;">Total: <strong>${escapeHtml(money(estimate?.total))}</strong></div>
    </div>

    <h3 style="margin:18px 0 6px;">Assumptions</h3>
    ${assumptionsHtml}

    <hr style="border:none;border-top:1px solid #eee;margin:18px 0;" />
    <div style="color:#555;font-size:12px;">
      This estimate is based on the provided inspection documents and may require confirmation on site.
      Reply to this email with any questions.
    </div>
  </div>
  `;
}

async function withTimeout(promise, ms, label = "operation") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function claimJob(supabase) {
  const { data: queued, error: qErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,name,phone,notes,binsr_url,inspection_url,status,started_at,ai_started_at,created_at")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (qErr) throw new Error(`DB pick queued failed: ${qErr.message}`);
  if (queued?.length) return queued[0];

  const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data: stale, error: sErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,name,phone,notes,binsr_url,inspection_url,status,started_at,ai_started_at,created_at")
    .in("status", ["processing", "ai_started"])
    .or(`started_at.lt.${staleCutoff},ai_started_at.lt.${staleCutoff}`)
    .order("created_at", { ascending: true })
    .limit(1);

  if (sErr) throw new Error(`DB pick stale failed: ${sErr.message}`);
  if (stale?.length) return stale[0];

  return null;
}

export default async function handler(req, res) {
  let currentJobId = null;

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const openaiKey = process.env.OPENAI_API_KEY;
    const sendgridKey = process.env.SENDGRID_API_KEY;
    const emailFrom = process.env.EMAIL_FROM;

    if (!supabaseUrl || !supabaseKey || !openaiKey || !sendgridKey || !emailFrom) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars",
        hasSUPABASE_URL: !!supabaseUrl,
        hasSUPABASE_SERVICE_ROLE_KEY: !!supabaseKey,
        hasOPENAI_API_KEY: !!openaiKey,
        hasSENDGRID_API_KEY: !!sendgridKey,
        hasEMAIL_FROM: !!emailFrom,
      });
    }

    sgMail.setApiKey(sendgridKey);

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    const job = await claimJob(supabase);
    if (!job) return res.status(200).json({ ok: true, message: "No queued jobs" });

    currentJobId = job.id;

    // Claim + mark processing
    await supabase.from("estimate_jobs").update({
      status: "processing",
      started_at: nowIso(),
      error: null,
    }).eq("id", job.id);

    console.log("PROCESS_JOB_START", job.id);

    // Fetch + parse PDFs
    const sources = [];
    if (job.binsr_url) sources.push({ label: "BINSR", url: job.binsr_url });
    if (job.inspection_url) sources.push({ label: "INSPECTION", url: job.inspection_url });
    if (!sources.length) throw new Error("Job has no PDF URLs (binsr_url/inspection_url)");

    let combined = "";
    for (const s of sources) {
      console.log("FETCH_PDF", job.id, s.label);
      const txt = await pdfTextFromUrl(s.url);
      combined += `\n\n===== ${s.label} TEXT START =====\n${txt}\n===== ${s.label} TEXT END =====\n`;
    }
    combined = clampText(combined);

    // AI start
    await supabase.from("estimate_jobs").update({
      status: "ai_started",
      ai_started_at: nowIso(),
    }).eq("id", job.id);

    console.log("AI_START", job.id);

    const prompt = `
You are BINSR Pros' repair estimator.
Create a detailed estimate based on the inspection documents below.

Customer:
- Name: ${job.name || ""}
- Email: ${job.email || ""}
- Phone: ${job.phone || ""}
- Notes: ${job.notes || ""}

DOCUMENT TEXT:
${combined}

Return STRICT JSON with this structure:
{
  "summary": string,
  "line_items": [
    {
      "code": string|null,
      "name": string,
      "description": string,
      "qty": number,
      "unit_price": number,
      "total": number
    }
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "assumptions": [string]
}
`;

    const resp = await withTimeout(
      openai.responses.create({
        model: "gpt-5-mini",
        input: prompt,
        text: { format: { type: "json_object" } },
      }),
      OPENAI_TIMEOUT_MS,
      "OpenAI call"
    );

    const textOut = resp.output_text;
    if (!textOut) throw new Error("OpenAI response missing output_text");

    let estimateJson;
    try {
      estimateJson = JSON.parse(textOut);
    } catch {
      throw new Error("Failed to parse OpenAI JSON output");
    }

    // Save estimate
    await supabase.from("estimate_jobs").update({
      status: "complete",
      ai_completed_at: nowIso(),
      completed_at: nowIso(),
      estimate_json: estimateJson,
      estimate_text: JSON.stringify(estimateJson, null, 2),
      error: null,
    }).eq("id", job.id);

    console.log("AI_DONE", job.id);

    // Send email to customer + internal copy
    const toList = [job.email, INTERNAL_COPY_EMAIL].filter(Boolean);
    const subject = `BINSR Pros Estimate - Job ${job.id}`;
    const html = buildEmailHtml(job, estimateJson);

    await sgMail.send({
      to: toList,
      from: emailFrom,
      subject,
      html,
    });

    // Mark email sent
    await supabase.from("estimate_jobs").update({
      email_sent_at: nowIso(),
      email_error: null,
    }).eq("id", job.id);

    console.log("EMAIL_SENT", job.id, toList);

    return res.status(200).json({ ok: true, jobId: job.id, status: "complete", emailed: toList });
  } catch (e) {
    console.error("process-job error:", e);

    // Best effort: mark job failed if we already claimed one
    try {
      if (currentJobId) {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });

        await supabase.from("estimate_jobs").update({
          status: "failed",
          error: String(e?.message || e),
        }).eq("id", currentJobId);
      }
    } catch (inner) {
      console.error("Failed to mark job failed:", inner);
    }

    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
