// pages/api/create-job.js
export const config = {
  api: { bodyParser: false }, // REQUIRED for multipart (file uploads)
  runtime: "nodejs",
};

import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";

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

async function parseForm(req) {
  const form = formidable({ multiples: true });
  return await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);

      // Flatten fields (formidable can return arrays)
      const flat = {};
      for (const k of Object.keys(fields)) {
        flat[k] = Array.isArray(fields[k]) ? fields[k][0] : fields[k];
      }
      resolve({ fields: flat, files });
    });
  });
}

// OPTIONAL: If Base44 gives you file uploads, you need to upload them somewhere.
// This helper uploads to Supabase Storage and returns a public URL.
// If you don't have Storage set up yet, see notes below.
async function uploadToSupabaseStorage(supabase, fileObj, pathPrefix) {
  // formidable v3 uses fileObj.filepath; older uses fileObj.path
  const filepath = fileObj.filepath || fileObj.path;
  const originalFilename = fileObj.originalFilename || fileObj.name || "upload.pdf";
  const contentType = fileObj.mimetype || "application/pdf";

  const fileBuffer = fs.readFileSync(filepath);
  const storagePath = `${pathPrefix}/${Date.now()}-${originalFilename}`.replace(/\s+/g, "_");

  const { data: up, error: upErr } = await supabase.storage
    .from("estimate_uploads")
    .upload(storagePath, fileBuffer, { contentType, upsert: false });

  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  const { data: pub } = supabase.storage.from("estimate_uploads").getPublicUrl(up.path);
  return pub.publicUrl;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // Parse JSON or multipart
  const contentType = req.headers["content-type"] || "";
  let body = {};
  let files = {};

  try {
    if (contentType.includes("application/json")) {
      // Manually read stream because bodyParser is disabled
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } else if (contentType.includes("multipart/form-data")) {
      const parsed = await parseForm(req);
      body = parsed.fields;
      files = parsed.files || {};
    } else {
      // Try parsing as form anyway (Base44 often uses multipart)
      const parsed = await parseForm(req);
      body = parsed.fields;
      files = parsed.files || {};
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: `Could not parse request body: ${e.message}` });
  }

  // Base44 fields
  const first_name = cleanStr(body.first_name ?? body.firstName ?? body["First Name"]);
  const last_name = cleanStr(body.last_name ?? body.lastName ?? body["Last Name"]);
  const phone = cleanStr(body.phone ?? body.phone_number ?? body["Phone Number"]);
  const email = cleanStr(body.email ?? body.email_address ?? body["Email Address"]);

  const close_of_escrow_date = normalizeDate(body.close_of_escrow_date ?? body["Close of Escrow Date"]);
  const property_address = cleanStr(body.property_address ?? body["Property Address"]);
  const city = cleanStr(body.city ?? body["City"]);
  const zip = normalizeZip(body.zip ?? body["Zip"]);
  const notes = cleanStr(body.notes);

  // If Base44 sends URLs as strings
  let binsr_url = cleanStr(body.binsr_url ?? body.binsr_document ?? body["BINSR Document"]);
  let inspection_url = cleanStr(body.inspection_url ?? body.full_inspection_report ?? body["Full Inspection Report"]);

  // If Base44 uploads actual files, upload them to Supabase Storage
  // IMPORTANT: Create a bucket named "estimate_uploads" in Supabase Storage.
  const binsrFile = files["BINSR Document"] || files["binsr_document"] || files["binsr"];
  const inspFile = files["Full Inspection Report"] || files["full_inspection_report"] || files["inspection"];

  if (!binsr_url && binsrFile) {
    binsr_url = await uploadToSupabaseStorage(supabase, Array.isArray(binsrFile) ? binsrFile[0] : binsrFile, "binsr");
  }
  if (!inspection_url && inspFile) {
    inspection_url = await uploadToSupabaseStorage(supabase, Array.isArray(inspFile) ? inspFile[0] : inspFile, "inspection");
  }

  if (!email) return bad(res, "Missing Email Address", { received_keys: Object.keys(body || {}) });
  if (!binsr_url) return bad(res, "Missing BINSR Document (URL or upload)", { received_file_keys: Object.keys(files || {}) });

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
