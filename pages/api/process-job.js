// pages/api/process-job.js
//
// Robust worker to process ONE estimate job per call:
// - Claims a queued job (or reclaims a stale processing job)
// - Downloads PDFs from Tally URLs
// - Extracts text with pdf-parse
// - Calls OpenAI with TEXT ONLY (no file_data)
// - Uses Responses API JSON mode via text.format
// - Saves estimate_json + status timestamps
// - Never leaves jobs stuck in "processing"
//
// Env vars required on Vercel (Production + Preview as needed):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
//
// Dependencies:
//   npm i pdf-parse openai @supabase/supabase-js

export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import pdf from "pdf-parse";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STALE_MINUTES = 15;        // reclaim jobs stuck in processing longer than this
const MAX_PROMPT_CHARS = 120000; // cap text sent to OpenAI to avoid token blowups
const FETCH_TIMEOUT_MS = 30000;

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r;
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

async function claimJob(supabase) {
  // 1) Try queued first
  const { data: queued, error: qErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,name,phone,notes,binsr_url,inspection_url,status,started_at,created_at")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (qErr) throw new Error(`DB pick queued failed: ${qErr.message}`);
  if (queued?.length) return queued[0];

  // 2) Reclaim stale processing
  const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data: stale, error: sErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,name,phone,notes,binsr_url,inspection_url,status,started_at,created_at")
    .eq("status", "processing")
    .lt("started_at", staleCutoff)
    .order("started_at", { ascending: true })
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

    if (!supabaseUrl || !supabaseKey || !openaiKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars",
        hasSUPABASE_URL: !!supabaseUrl,
        hasSUPABASE_SERVICE_ROLE_KEY: !!supabaseKey,
        hasOPENAI_API_KEY: !!openaiKey,
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    // Pick a job
    const job = await claimJob(supabase);
    if (!job) return res.status(200).json({ ok: true, message: "No queued jobs" });

    currentJobId = job.id;

    // Mark as processing + timestamp
    await supabase
      .from("estimate_jobs")
      .update({ status: "processing", started_at: nowIso(), error: null })
      .eq("id", job.id);

    console.log("PROCESS_JOB_START", job.id);

    // Fetch + parse PDFs
    const sources = [];
    if (job.binsr_url) sources.push({ label: "BINSR", url: job.binsr_url });
    if (job.inspection_url) sources.push({ label: "INSPECTION", url: job.inspection_url });

    if (!sources.length) {
      throw new Error("Job has no PDF URLs (binsr_url/inspection_url are empty)");
    }

    let combined = "";
    for (const s of sources) {
      console.log("FETCH_PDF", job.id, s.label);
      const txt = await pdfTextFromUrl(s.url);
      combined += `\n\n===== ${s.label} TEXT START =====\n${txt}\n===== ${s.label} TEXT END =====\n`;
    }

    combined = clampText(combined);

    // Mark AI start
    await supabase
      .from("estimate_jobs")
      .update({ ai_started_at: nowIso(), status: "ai_started" })
      .eq("id", job.id);

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

    // ✅ Updated for Responses API: response_format -> text.format
    const resp = await openai.responses.create({
      model: "gpt-5-mini",
      input: prompt,
      text: { format: { type: "json_object" } },
    });

    const textOut = resp.output_text;
    if (!textOut) throw new Error("OpenAI response missing output_text");

    let estimateJson;
    try {
      estimateJson = JSON.parse(textOut);
    } catch {
      throw new Error("Failed to parse OpenAI JSON output");
    }

    // Mark AI done + complete
    await supabase
      .from("estimate_jobs")
      .update({
        status: "complete",
        ai_completed_at: nowIso(),
        completed_at: nowIso(),
        estimate_json: estimateJson,
        estimate_text: JSON.stringify(estimateJson, null, 2),
        error: null,
      })
      .eq("id", job.id);

    console.log("PROCESS_JOB_DONE", job.id);

    return res.status(200).json({ ok: true, jobId: job.id, status: "complete" });
  } catch (e) {
    console.error("process-job error:", e);

    // Best effort: mark job failed if we already claimed one
    try {
      if (currentJobId) {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        await supabase
          .from("estimate_jobs")
          .update({ status: "failed", error: String(e?.message || e) })
          .eq("id", currentJobId);
      }
    } catch (inner) {
      console.error("Failed to mark job failed:", inner);
    }

    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
