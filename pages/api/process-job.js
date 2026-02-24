// pages/api/process-job.js
//
// PRICEBOOK + TEMPLATE-BLOCK ENFORCED WORKER (UPDATED)
// - Supabase is source of truth for: PRICEBOOK, ALIASES, RULES, TRIP FEES, TEMPLATES, TEMPLATE_BLOCKS
// - 2-stage AI: extract items -> map to codes (NO pricing, NO tax)
// - Pricing enforced in code from pricebook_items (model cannot invent pricing)
// - Trip fee applied from trip_fees (requires pricebook code TRIP_FEE)
// - Tax computed in code from template block TAX_RATE (fallback env TAX_RATE_DEFAULT)
// - Email HTML rendered from templates.body_html + block placeholders:
//     {HEADER_TITLE},{HEADER_SUBTITLE},{INTRO_TITLE},{INTRO_BODY},{WARRANTY_TITLE},{WARRANTY_BODY},
//     {PAYMENT_TITLE},{PAYMENT_BODY},{TRIP_FEE_RULE},{TAX_RATE},{TOTAL_LABEL}
//   Runtime placeholders:
//     {JobID},{Summary},{LineItemsTable},{Subtotal},{TripFee},{Tax},{Total}
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
//   TAX_RATE_DEFAULT          (default 0.112)
//   TEMPLATE_KEY_DEFAULT      (default "BINSR_PROS_REPAIR_ESTIMATE_V1")
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

const INCLUDE_INSPECTION =
  String(process.env.INCLUDE_INSPECTION || "false").toLowerCase() === "true";
const MAX_PDF_TEXT_CHARS = Number(process.env.MAX_PDF_TEXT_CHARS || 35000);
const STALE_MINUTES = Number(process.env.STALE_MINUTES || 20);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
const TAX_RATE_DEFAULT = Number(process.env.TAX_RATE_DEFAULT || 0.112);
const TEMPLATE_KEY_DEFAULT =
  String(process.env.TEMPLATE_KEY_DEFAULT || "BINSR_PROS_REPAIR_ESTIMATE_V1");

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
  return String(str ?? "")
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
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLineItemsTableHtml(items) {
  const rows = (items || [])
    .slice(0, 80)
    .map((li) => {
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;">
            <strong>${escapeHtml(li?.name || li?.code || "")}</strong>
            ${
              li?.description
                ? `<div style="color:#555;font-size:12px;margin-top:2px;">${escapeHtml(li.description)}</div>`
                : ""
            }
          </td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(
            String(li?.qty ?? "")
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(
            money(li?.unit_price)
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${escapeHtml(
            money(li?.total)
          )}</td>
        </tr>
      `;
    })
    .join("");

  return `
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
        ${
          rows ||
          `<tr><td colspan="4" style="padding:8px;color:#555;">No line items returned.</td></tr>`
        }
      </tbody>
    </table>
  `;
}

// Turn template_blocks rows into a placeholder map for a template_key
function blocksToMap(templateBlocks, templateKey) {
  const m = new Map();

  const blocks = (templateBlocks || [])
    .filter((b) => String(b.template_key || "").trim() === templateKey)
    .filter((b) => String(b.active || "Y").trim().toUpperCase() !== "N")
    .sort((a, b) => Number(a.block_order || 0) - Number(b.block_order || 0));

  for (const b of blocks) {
    const key = String(b.block_key || "").trim();
    if (!key) continue;

    // block_value is stored as string/number in DB
    let val = b.block_value;

    // Normalize by type
    const t = String(b.block_type || "text").toLowerCase();
    if (t === "number") {
      // Keep as string so it pastes cleanly into HTML
      val = String(val);
    } else if (t === "lookup") {
      // Typically "tblTripFees" per your Excel; keep as string label
      val = String(val);
    } else {
      val = String(val ?? "");
    }

    m.set(key, val);
  }

  return m;
}

// Replace {BLOCK_KEY} placeholders with values from blockMap, then fill runtime placeholders.
function applyPlaceholders(templateHtml, ctx, blockMap) {
  let html = String(templateHtml ?? "");

  // 1) Fill block placeholders like {HEADER_TITLE}
  if (blockMap && blockMap.size) {
    for (const [k, v] of blockMap.entries()) {
      html = html.replaceAll(`{${k}}`, String(v ?? ""));
    }
  }

  // 2) Fill runtime placeholders
  const pairs = [
    ["{JobID}", ctx.jobId ?? ""],
    ["{Summary}", ctx.summary ?? ""],
    ["{LineItemsTable}", ctx.lineItemsTable ?? ""],
    ["{Subtotal}", money(ctx.subtotal)],
    ["{TripFee}", money(ctx.tripFee)],
    ["{Tax}", money(ctx.tax)],
    ["{Total}", money(ctx.total)],
  ];

  for (const [k, v] of pairs) html = html.replaceAll(k, String(v ?? ""));
  return html;
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

  const [pbRes, aliasRes, tripRes, rulesRes, tmplRes, tmplBlocksRes] = await Promise.all([
    supabase.from("pricebook_items").select("code,name,unit,unit_price,min_qty,notes").eq("active", true),
    supabase.from("aliases").select("alias,code").eq("active", true),
    supabase.from("trip_fees").select("label,base_fee,per_mile,after_hours_fee").eq("active", true),
    supabase
      .from("estimate_rules")
      .select("rule_key,rule_text,priority")
      .eq("active", true)
      .order("priority", { ascending: true }),
    supabase.from("templates").select("template_key,subject,body_html").eq("active", true),
    supabase
      .from("template_blocks")
      .select("template_key,block_key,block_type,block_order,block_value,active")
      .eq("active", true),
  ]);

  if (pbRes.error) throw new Error(`pricebook_items load failed: ${pbRes.error.message}`);
  if (aliasRes.error) throw new Error(`aliases load failed: ${aliasRes.error.message}`);
  if (tripRes.error) throw new Error(`trip_fees load failed: ${tripRes.error.message}`);
  if (rulesRes.error) throw new Error(`estimate_rules load failed: ${rulesRes.error.message}`);
  if (tmplRes.error) throw new Error(`templates load failed: ${tmplRes.error.message}`);
  if (tmplBlocksRes.error) throw new Error(`template_blocks load failed: ${tmplBlocksRes.error.message}`);

  const pricebook = pbRes.data || [];
  const aliases = aliasRes.data || [];
  const tripFees = tripRes.data || [];
  const rules = rulesRes.data || [];
  const templates = tmplRes.data || [];
  const templateBlocks = tmplBlocksRes.data || [];

  const pricebookMap = new Map(pricebook.map((p) => [p.code, p]));
  const aliasMap = new Map(aliases.map((a) => [String(a.alias || "").toLowerCase(), a.code]));

  return { cfg, pricebook, pricebookMap, aliasMap, tripFees, rules, templates, templateBlocks };
}

function getTaxRateFromTemplateBlocks(blockMap) {
  // Prefer TAX_RATE block if present (stored as decimal string like "0.112")
  const raw = blockMap?.get("TAX_RATE");
  if (raw === undefined || raw === null || raw === "") return TAX_RATE_DEFAULT;

  const n = Number(String(raw).trim().replace("%", ""));
  if (!Number.isFinite(n)) return TAX_RATE_DEFAULT;

  // If "11.2" or "11.2%" interpret as percent; if "0.112" keep as decimal
  if (String(raw).includes("%") || n > 1) return round2(n / 100);
  return n;
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
      unmapped.push({ ...li, reason: "code_not_in_pricebook" });
      continue;
    }

    const qtyNum = Number(li?.qty ?? pb.min_qty ?? 1);
    const qty =
      Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : Number(pb.min_qty || 1);

    const unitPrice = Number(pb.unit_price);
    const total = round2(qty * unitPrice);

    // If the model tried to supply unit_price, flag it
    const modelUnitPrice = li?.unit_price;
    if (modelUnitPrice !== undefined && modelUnitPrice !== null) {
      const mup = Number(modelUnitPrice);
      if (Number.isFinite(mup) && round2(mup) !== round2(unitPrice)) {
        errors.push(`Model attempted unit_price for ${code}: model=${mup} pricebook=${unitPrice}`);
      }
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

  return {
    corrected: {
      summary: String(mapped?.summary || ""),
      line_items: fixed,
      subtotal,
      assumptions: Array.isArray(mapped?.assumptions) ? mapped.assumptions.map(String) : [],
      unmapped_items: Array.isArray(mapped?.unmapped_items) ? mapped.unmapped_items : [],
    },
    errors,
    unmapped,
  };
}

function bestAliasMatch(rawText, aliasMap) {
  // Prefer longest alias contained in rawText
  const t = normalize(rawText);
  let best = null;
  for (const [alias, code] of aliasMap.entries()) {
    if (!alias) continue;
    if (t.includes(alias)) {
      if (!best || alias.length > best.alias.length) best = { alias, code };
    }
  }
  return best;
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
      TAX_RATE_DEFAULT,
      TEMPLATE_KEY_DEFAULT,
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
    if (INCLUDE_INSPECTION && job.inspection_url)
      sources.push({ label: "INSPECTION", url: job.inspection_url });
    if (!sources.length) throw new Error("Job has no PDF URLs (binsr_url/inspection_url)");

    let combined = "";
    for (const s of sources) {
      console.log("FETCH_PDF", job.id, s.label);
      const txt = await pdfTextFromUrl(s.url);
      combined += `\n\n===== ${s.label} =====\n${txt}\n`;
      await sleep(25);
    }
    combined = clamp(combined, MAX_PDF_TEXT_CHARS);

    // Mark AI started
    debug.steps.push("mark_ai_started");
    await supabase
      .from("estimate_jobs")
      .update({ status: "ai_started", ai_started_at: nowIso() })
      .eq("id", job.id);

    const openai = new OpenAI({ apiKey: openaiKey });

    // Stage A: extract items (NO pricing)
    debug.steps.push("ai_stage_a_extract");
    const stageASchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              raw_text: { type: "string" },
              qty: { type: ["number", "null"] },
              notes: { type: ["string", "null"] },
            },
            required: ["raw_text", "qty", "notes"],
          },
        },
      },
      required: ["items"],
    };

    const stageA = await withTimeout(
      openai.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "system",
            content:
              "Extract repair/defect items from the document text. Do NOT price anything. Return ONLY JSON matching the schema.",
          },
          {
            role: "user",
            content: `DOCUMENT TEXT:\n${combined}`,
          },
        ],
        text: { format: { type: "json_schema", name: "stage_a_extract", schema: stageASchema } },
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
      const best = bestAliasMatch(it?.raw_text || "", config.aliasMap);
      if (best?.code) candidates.add(best.code);
    }
    const shortlist = config.pricebook.filter((p) => candidates.has(p.code)).slice(0, 600);
    const pbForModel = shortlist.length ? shortlist : config.pricebook.slice(0, 600);

    // Stage B: map items to codes (NO pricing, NO tax)
    debug.steps.push("ai_stage_b_map");
    const rulesText = (config.rules || [])
      .map((r) => `- (${r.rule_key}) ${r.rule_text}`)
      .join("\n");

    const stageBSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        line_items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              description: { type: "string" },
              qty: { type: "number" },
            },
            required: ["code", "description", "qty"],
          },
        },
        assumptions: { type: "array", items: { type: "string" } },
        unmapped_items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { raw_text: { type: "string" }, reason: { type: "string" } },
            required: ["raw_text", "reason"],
          },
        },
      },
      required: ["summary", "line_items", "assumptions", "unmapped_items"],
    };

    const stageB = await withTimeout(
      openai.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "system",
            content:
              "Map extracted items to PRICEBOOK codes only. Do NOT invent codes. Do NOT include prices or tax. Return ONLY JSON matching schema.",
          },
          {
            role: "user",
            content: `RULES:\n${rulesText || "(none)"}\n\nPRICEBOOK (allowed codes):\n${JSON.stringify(
              pbForModel
            )}\n\nEXTRACTED ITEMS:\n${JSON.stringify(extractedItems)}`,
          },
        ],
        text: { format: { type: "json_schema", name: "stage_b_map", schema: stageBSchema } },
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
    let tripFeeAmount = 0;
    if (config.tripFees?.length) {
      const tf = config.tripFees[0]; // simplest: first active row
      const pbTrip = config.pricebookMap.get("TRIP_FEE");
      if (pbTrip) {
        tripFeeAmount = round2(Number(tf.base_fee || 0));
        corrected.line_items.push({
          code: "TRIP_FEE",
          name: pbTrip.name,
          description: `Trip Fee - ${tf.label}`,
          qty: 1,
          unit_price: tripFeeAmount,
          total: tripFeeAmount,
        });
        corrected.subtotal = round2(corrected.subtotal + tripFeeAmount);
      } else {
        errors.push("Trip fee skipped: pricebook code TRIP_FEE not found.");
      }
    }

    // Select template + blocks
    debug.steps.push("select_template");
    const templateKey = TEMPLATE_KEY_DEFAULT;
    const tmpl = (config.templates || []).find((t) => t.template_key === templateKey);
    if (!tmpl?.body_html) throw new Error(`Missing templates.body_html for template_key=${templateKey}`);

    const blockMap = blocksToMap(config.templateBlocks, templateKey);
    debug.template_key = templateKey;
    debug.template_blocks_count = blockMap.size;

    // Compute tax + total from TAX_RATE block (fallback env)
    debug.steps.push("compute_tax_total");
    const taxRate = getTaxRateFromTemplateBlocks(blockMap);
    const tax = round2(corrected.subtotal * taxRate);
    const total = round2(corrected.subtotal + tax);

    corrected.tax_rate = taxRate;
    corrected.tax = tax;
    corrected.total = total;
    corrected.trip_fee = tripFeeAmount;
    corrected.estimate_id = job.id;

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

    // Render HTML from template + placeholders
    debug.steps.push("render_template");
    const ctx = {
      jobId: job.id,
      summary: corrected.summary || "",
      lineItemsTable: buildLineItemsTableHtml(corrected.line_items || []),
      subtotal: corrected.subtotal ?? 0,
      tripFee: corrected.trip_fee ?? 0,
      tax: corrected.tax ?? 0,
      total: corrected.total ?? 0,
    };

    // Also provide TRIP_FEE_RULE and TAX_RATE placeholders via blocks
    // (blocks already fill them when template contains {TRIP_FEE_RULE} and {TAX_RATE})
    const subject = String(tmpl.subject || `BINSR Pros Estimate - Job ${job.id}`).trim();
    const html = applyPlaceholders(tmpl.body_html, ctx, blockMap);

    // Email (customer + internal copy)
    debug.steps.push("send_email");
    sgMail.setApiKey(sendgridKey);

    const toList = [job.email, INTERNAL_COPY_EMAIL].filter(Boolean);

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

    return res.status(200).json({
      ok: true,
      jobId: job.id,
      emailed: toList,
      debug,
    });
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
