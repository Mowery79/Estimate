// pages/api/sync-base44-estimate.js
export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";

function bad(res, msg) {
  return res.status(400).json({ ok: false, error: msg });
}

async function base44Fetch(path, method, apiUrl, apiKey, body) {
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`Base44 ${method} ${path} failed: ${r.status} ${text.slice(0, 500)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base44ApiUrl = process.env.BASE44_API_URL;
  const base44ApiKey = process.env.BASE44_API_KEY;

  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });
  if (!base44ApiUrl || !base44ApiKey) return res.status(500).json({ ok: false, error: "Missing Base44 env vars" });

  const { jobId } = req.body || {};
  if (!jobId) return bad(res, "Missing jobId");

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // 1) Load job from Supabase
  const { data: job, error: jErr } = await supabase
    .from("estimate_jobs")
    .select("id,email,base44_job_id,base44_estimate_id,estimate_json,status")
    .eq("id", jobId)
    .maybeSingle();

  if (jErr || !job) return res.status(404).json({ ok: false, error: jErr?.message || "Job not found" });
  if (!job.estimate_json) return res.status(400).json({ ok: false, error: "No estimate_json to sync yet" });

  // 2) Build Base44 Estimate payload (store JSON as a string if needed)
  const est = job.estimate_json;
  const payload = {
    supabase_job_id: job.id,
    base44_job_id: job.base44_job_id || null,
    agent_email: job.email || null,
    status: job.status || "complete",
    summary: est.summary || "",
    subtotal: est.subtotal ?? 0,
    tax: est.tax ?? 0,
    total: est.total ?? 0,
    line_items_json: JSON.stringify(est.line_items || []),
  };

  // 3) Upsert in Base44
  // IMPORTANT: adjust endpoint paths to Base44’s actual API for entity upsert.
  // Pattern shown below:
  // - first: search by supabase_job_id
  // - then: create or update
  let base44EstimateId = job.base44_estimate_id || null;

  if (!base44EstimateId) {
    const found = await base44Fetch(
      `/entities/Estimate/search`,
      "POST",
      base44ApiUrl,
      base44ApiKey,
      { filter: { supabase_job_id: job.id }, limit: 1 }
    );
    base44EstimateId = found?.data?.[0]?.id || null;
  }

  let saved;
  if (base44EstimateId) {
    saved = await base44Fetch(
      `/entities/Estimate/${base44EstimateId}`,
      "PATCH",
      base44ApiUrl,
      base44ApiKey,
      payload
    );
  } else {
    saved = await base44Fetch(
      `/entities/Estimate`,
      "POST",
      base44ApiUrl,
      base44ApiKey,
      payload
    );
    base44EstimateId = saved?.id || saved?.data?.id || null;
  }

  if (!base44EstimateId) throw new Error("Base44 did not return an estimate id");

  // 4) Save Base44 estimate id back to Supabase
  await supabase
    .from("estimate_jobs")
    .update({ base44_estimate_id: base44EstimateId })
    .eq("id", job.id);

  return res.status(200).json({ ok: true, base44_estimate_id: base44EstimateId });
}
