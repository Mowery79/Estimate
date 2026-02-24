// pages/api/process-job.js
//
// PRICEBOOK-ENFORCED WORKER (NEWEST)
// - Uses Supabase as source of truth for PRICEBOOK, ALIASES, RULES, TRIP FEES, TEMPLATES
// - 2-stage AI: extract items -> map to codes (NO pricing)
// - Pricing enforced in code from pricebook_items (model cannot invent pricing)
// - Trip fee applied from trip_fees (requires pricebook code TRIP_FEE)
// - Emails estimate to customer + BINSR@dignhomes.com (SendGrid)
// - Debuggable response with steps + stack on failure
//
// REQUIRED Vercel env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
//   SENDGRID_API_KEY
//   EMAIL_FROM
//
// OPTIONAL env vars:
//   INCLUDE_INSPECTION        (default "false")  -> include inspection report PDF
//   MAX_PDF_TEXT_CHARS        (default 35000)    -> limits PDF text fed to AI
//   STALE_MINUTES             (default 20)
//   OPENAI_TIMEOUT_MS         (default 120000)
//
// Dependencies:
//   npm i pdf-parse openai @supabase/supabase-js @sendgrid/mail

export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import pdf from "pdf-parse";
import sgMail from "@sendgrid/mail";

const INTERNAL_COPY_EMAIL = "BINSR@dignhomes.com";
const FETCH_TIMEOUT_MS = 30000;

const INCLUDE_INSPECTION = String(process.env.INCLUDE_INSPECTION || "false").toLowerCase() === "true";
const MAX_PDF_TEXT_CHARS = Number(process.env.MAX_PDF_TEXT_CHARS || 35000);
const STALE_MINUTES = Number(process.env.STALE_MINUTES || 20);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120000);

function nowIso() {
  return new Date().toISOString();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
function clamp(text, maxChars) {
  if (!text) return "";
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "\n\n[TRUNCATED]";
}
async function pdfTextFromUrl(url) {
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`Failed to fetch PDF (${r.status}) from ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const parsed = await pdf(buf);
  return parsed?.text || "";
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

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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
      const name = li?.name ?? li?.code ?? "";
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

    <hr style="border:none;border-top:1px solid #eee;margin:18px 0;" />
    <div style="color:#555;font-size:12px;">
      This estimate uses BINSR Pros pricebook and rules.
    </div>
  </div>
  `;
}

// Status variants (case/spacing issues)
const QUEUED_VARIANTS = ["queued", "Queued", "QUEUED"];
const PROCESSING_VARIANTS = ["processing", "Processing", "PROCESSING"];
const AI_STARTED_VARIANTS = ["ai_started", "AI_STARTED", "Ai_Started", "ai-started", "AI-STARTED"];

async function claimJob(supabase) {
  // queued first
  const { data: queued, error: qErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,name,phone,notes,binsr_url,inspection_url,status,started_at,ai_started_at,created_at")
    .in("status", QUEUED_VARIANTS)
    .order("created_at", { ascending: true })
    .limit(1);

  if (qErr) throw new Error(`DB pick queued failed: ${qErr.message}`);
  if (queued?.length) return queued[0];

  // reclaim stale processing / ai_started
  const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const { data: stale, error: sErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,name,phone,notes,binsr_url,inspection_url,status,started_at,ai_started_at,created_at")
    .in("status", [...PROCESSING_VARIANTS, ...AI_STARTED_VARIANTS])
    .or(`started_at.lt.${staleCutoff},ai_started_at.lt.${staleCutoff}`)
    .order("created_at", { ascending: true })
    .limit(1);

  if (sErr) throw new Error(`DB pick stale failed: ${sErr.message}`);
  if (stale?.length) return stale[0];

  return null;
}

async function loadActiveConfig(supabase) {
  const { data: cfg, error: cfgErr } = await supabase
    .from("config_versions")
    .select("id,label")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (cfgErr || !cfg) throw new Error("No active config_versions row found.");

  const [
    pbRes,
    aliasRes,
    tripRes,
    rulesRes,
    tmplRes,
  ] = await Promise.all([
    supabase.from("pricebook_items").select("code,name,unit,unit_price,min_qty,notes").eq("active", true),
    supabase.from("aliases").select("alias,code").eq("active", true),
    supabase.from("trip_fees").select("label,base_fee,per_mile,after_hours_fee").eq("active", true),
    supabase.from("estimate_rules").select("rule_key,rule_text,priority").eq("active", true).order("priority", { ascending: true }),
    supabase.from("templates").select("template_key,subject,body_html").eq("active", true),
  ]);

  if (pbRes.error) throw new Error(`pricebook_items load failed: ${pbRes.error.message}`);
  if (aliasRes.error) throw new Error(`aliases load failed: ${aliasRes.error.message}`);
  if (tripRes.error) throw new Error(`trip_fees load failed: ${tripRes.error.message}`);
  if (rulesRes.error) throw new Error(`estimate_rules load failed: ${rulesRes.error.message}`);
  if (tmplRes.error) throw new Error(`templates load failed: ${tmplRes.error.message}`);

  const pricebook = pbRes.data || [];
  const aliases = aliasRes.data || [];
  const tripFees = tripRes.data || [];
  const rules = rulesRes.data || [];
  const templates = tmplRes.data || [];

  const pricebookMap = new Map(pricebook.map((p) => [p.code, p]));
  const aliasMap = new Map(aliases.map((a) => [String(a.alias).toLowerCase(), a.code]));

  return { cfg, pricebook, pricebookMap, aliasMap, tripFees, rules, templates };
}

function validateAndPrice(mapped, pricebookMap) {
  const errors = [];
  const unmapped = [];

  const lineItems = Array.isArray(mapped?.line_items) ? mapped.line_items : [];
  const fixed = [];

  for (const li of lineItems) {
    const code = String(li?.code || "").trim();
    const pb = pricebookMap.get(code);
    if (!pb) {
      unmapped.push(li);
      continue;
    }

    const qtyNum = Number(li?.qty ?? pb.min_qty ?? 1);
    const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : Number(pb.min_qty || 1);

    const unitPrice = Number(pb.unit_price);
    const total = round2(qty * unitPrice);

    if (Number(li?.unit_price) && Number(li?.unit_price) !== unitPrice) {
      errors.push(`Overrode unit_price for ${code}: model=${li.unit_price} pricebook=${unitPrice}`);
    }

    fixed.push({
      code: pb.code,
      name: pb.name,
      description: String(li?.description || ""),
      qty,
      unit_price: unitPrice,
      total,
    });
  }

  const subtotal = round2(fixed.reduce((s, x) => s + Number(x.total || 0), 0));
  const tax = round2(Number(mapped?.tax || 0));
  const total = round2(subtotal + tax);

  return {
    corrected: {
      summary: String(mapped?.summary || ""),
      line_items: fixed,
      subtotal,
      tax,
      total,
      assumptions: Array.isArray(mapped?.assumptions) ? mapped.assumptions.map(String) : [],
    },
    errors,
    unmapped,
  };
}

export default async function handler(req, res) {
  let currentJobId = null;

  const debug = {
    env: {
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      INCLUDE_INSPECTION,
      MAX_PDF_TEXT_CHARS,
      STALE_MINUTES,
      OPENAI_TIMEOUT_MS,
    },
    steps: [],
  };

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const sendgridKey = process.env.SENDGRID_API_KEY;
    const emailFrom = process.env.EMAIL_FROM;

    if (!supabaseUrl || !supabaseKey || !openaiKey || !sendgridKey || !emailFrom) {
      return res.status(500).json({ ok: false, error: "Missing env vars", debug });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    debug.steps.push("load_config");
    const config = await loadActiveConfig(supabase);

    debug.steps.push("claim_job");
    const job = await claimJob(supabase);
    if (!job) return res.status(200).json({ ok: true, message: "No queued jobs", debug });

    currentJobId = job.id;
    debug.jobId = job.id;
    debug.configVersion = config.cfg;

    debug.steps.push("mark_processing");
    await supabase
      .from("estimate_jobs")
      .update({
        status: "processing",
        started_at: nowIso(),
        error: null,
        email_error: null,
        config_version_id: config.cfg.id,
      })
      .eq("id", job.id);

    console.log("PROCESS_JOB_START", job.id);

    // PDFs to use
    debug.steps.push("fetch_parse_pdfs");
    const sources = [];
    if (job.binsr_url) sources.push({ label: "BINSR", url: job.binsr_url });
    if (INCLUDE_INSPECTION && job.inspection_url) sources.push({ label: "INSPECTION", url: job.inspection_url });
    if (!sources.length) throw new Error("Job has no PDF URLs (binsr_url/inspection_url)");

    let combined = "";
    for (const s of sources) {
      console.log("FETCH_PDF", job.id, s.label);
      const txt = await pdfTextFromUrl(s.url);
      combined += `\n\n===== ${s.label} =====\n${txt}\n`;
      await sleep(25);
    }
    combined = clamp(combined, MAX_PDF_TEXT_CHARS);

    // Stage A: extract items (NO pricing)
    debug.steps.push("mark_ai_started");
    await supabase.from("estimate_jobs").update({ status: "ai_started", ai_started_at: nowIso() }).eq("id", job.id);

    debug.steps.push("ai_stage_a_extract");
    const openai = new OpenAI({ apiKey: openaiKey });

    const stageA = await withTimeout(
      openai.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "user",
            content: `Extract repair items from the document text. Do NOT price anything.
Return STRICT JSON:
{"items":[{"raw_text":string,"qty":number|null,"notes":string|null}]}

DOCUMENT TEXT:
${combined}`,
          },
        ],
        text: { format: { type: "json_object" } },
      }),
      OPENAI_TIMEOUT_MS,
      "OpenAI stage A"
    );

    const stageAText = stageA.output_text;
    if (!stageAText) throw new Error("Stage A missing output_text");
    const extracted = JSON.parse(stageAText);
    const extractedItems = Array.isArray(extracted?.items) ? extracted.items : [];

    // Build shortlist of codes from aliases (keeps Stage B fast)
    debug.steps.push("build_shortlist");
    const candidates = new Set();
    for (const it of extractedItems) {
      const raw = String(it?.raw_text || "").toLowerCase();
      for (const [alias, code] of config.aliasMap.entries()) {
        if (raw.includes(alias)) candidates.add(code);
      }
    }
    const shortlist = config.pricebook.filter((p) => candidates.has(p.code)).slice(0, 500);

    // Stage B: map items to codes (NO pricing)
    debug.steps.push("ai_stage_b_map");
    const rulesText = (config.rules || []).map((r) => `- (${r.rule_key}) ${r.rule_text}`).join("\n");

    const stageB = await withTimeout(
      openai.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "user",
            content: `You must ONLY use codes from the PRICEBOOK list provided. Do not invent codes or prices.
If an item cannot be mapped, put it under "unmapped_items" with a reason.

RULES:
${rulesText || "(none)"}

PRICEBOOK:
${JSON.stringify(shortlist.length ? shortlist : config.pricebook.slice(0, 150))}

EXTRACTED ITEMS:
${JSON.stringify(extractedItems)}

Return STRICT JSON:
{
  "summary": string,
  "line_items": [{"code": string, "description": string, "qty": number}],
  "tax": number,
  "assumptions": [string],
  "unmapped_items": [{"raw_text": string, "reason": string}]
}`,
          },
        ],
        text: { format: { type: "json_object" } },
      }),
      OPENAI_TIMEOUT_MS,
      "OpenAI stage B"
    );

    const stageBText = stageB.output_text;
    if (!stageBText) throw new Error("Stage B missing output_text");
    const mapped = JSON.parse(stageBText);

    // Enforce pricing from pricebook
    debug.steps.push("validate_and_price");
    const { corrected, errors, unmapped } = validateAndPrice(mapped, config.pricebookMap);

    // Apply trip fee (requires TRIP_FEE exists in pricebook)
    debug.steps.push("apply_trip_fee");
    if (config.tripFees?.length) {
      const tf = config.tripFees[0]; // simplest: first active row
      const pbTrip = config.pricebookMap.get("TRIP_FEE");
      if (pbTrip) {
        const fee = round2(Number(tf.base_fee || 0));
        corrected.line_items.push({
          code: "TRIP_FEE",
          name: pbTrip.name,
          description: `Trip Fee - ${tf.label}`,
          qty: 1,
          unit_price: fee,
          total: fee,
        });
        corrected.subtotal = round2(corrected.subtotal + fee);
        corrected.total = round2(corrected.subtotal + corrected.tax);
      } else {
        errors.push("Trip fee skipped: pricebook code TRIP_FEE not found.");
      }
    }

    // Save + complete
    debug.steps.push("save_estimate_complete");
    await supabase
      .from("estimate_jobs")
      .update({
        status: "complete",
        ai_completed_at: nowIso(),
        completed_at: nowIso(),
        estimate_json: corrected,
        estimate_text: JSON.stringify(corrected, null, 2),
        validation_errors: errors.length ? errors.join("\n") : null,
        unmapped_items: unmapped?.length ? unmapped : null,
        error: null,
      })
      .eq("id", job.id);

    console.log("AI_DONE", job.id);

    // Email (customer + internal copy)
    debug.steps.push("send_email");
    sgMail.setApiKey(sendgridKey);

    const toList = [job.email, INTERNAL_COPY_EMAIL].filter(Boolean);
    const subject = `BINSR Pros Estimate - Job ${job.id}`;
    const html = buildEmailHtml(job, corrected);

    try {
      await sgMail.send({ to: toList, from: emailFrom, subject, html });

      debug.steps.push("mark_email_sent");
      await supabase.from("estimate_jobs").update({ email_sent_at: nowIso(), email_error: null }).eq("id", job.id);
      console.log("EMAIL_SENT", job.id, toList);
    } catch (mailErr) {
      const msg = String(mailErr?.message || mailErr);
      await supabase.from("estimate_jobs").update({ email_error: msg }).eq("id", job.id);
      console.error("EMAIL_FAILED", job.id, msg);
      return res.status(200).json({ ok: true, jobId: job.id, emailed: false, email_error: msg, debug });
    }

    return res.status(200).json({ ok: true, jobId: job.id, emailed: toList, debug });
  } catch (e) {
    console.error("process-job error:", e);

    // Mark failed
    try {
      if (currentJobId) {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        await supabase.from("estimate_jobs").update({ status: "failed", error: String(e?.message || e) }).eq("id", currentJobId);
      }
    } catch {}

    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      stack: String(e?.stack || ""),
      debug,
    });
  }
}
