// pages/api/create-job.js
export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";

function bad(res, msg, extra = {}) {
  return res.status(400).json({ ok: false, error: msg, ...extra });
}
function cleanStr(v) {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
function normalizeDate(v) {
  const s = cleanStr(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  return null;
}
function normalizeZip(v) {
  const s = cleanStr(v);
  if (!s) return null;
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

// Handles strings or objects/arrays that contain {url:"..."}
function extractUrl(v) {
  if (!v) return null;
  if (typeof v === "string") return cleanStr(v);
  if (Array.isArray(v)) return extractUrl(v[0]);
  if (typeof v === "object") return cleanStr(v.url || v.href || v.link);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  const body = req.body || {};

  // Base44 fields (accept various key styles)
  const first_name = cleanStr(body.first_name ?? body.firstName ?? body["First Name"]);
  const last_name = cleanStr(body.last_name ?? body.lastName ?? body["Last Name"]);
  const phone = cleanStr(body.phone ?? body.phone_number ?? body["Phone Number"]);
  const email = cleanStr(body.email ?? body.email_address ?? body["Email Address"]);

  const close_of_escrow_date = normalizeDate(body.close_of_escrow_date ?? body["Close of Escrow Date"]);
  const property_address = cleanStr(body.property_address ?? body["Property Address"]);
  const city = cleanStr(body.city ?? body["City"]);
  const zip = normalizeZip(body.zip ?? body["Zip"]);

  // File URLs (already uploaded client-side)
  const binsr_url = extractUrl(body.binsr_url ?? body.binsr_document ?? body["BINSR Document"]);
  const inspection_url = extractUrl(body.inspection_url ?? body.full_inspection_report ?? body["Full Inspection Report"]);

  const notes = cleanStr(body.notes);

  if (!email) return bad(res, "Missing Email Address");
  if (!binsr_url) return bad(res, "Missing BINSR Document URL");

  const { data, error } = await supabase
    .from("estimate_jobs")
    .insert({
      email,
      phone,
      notes,
      first_name,
      last_name,
      close_of_escrow_date,
      property_address,
      city,
      zip,
      binsr_url,
      inspection_url,
      status: "queued",
    })
    .select("id")
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  return res.status(200).json({ ok: true, jobId: data.id });
}
