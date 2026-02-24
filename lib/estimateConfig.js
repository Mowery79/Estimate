// lib/estimateConfig.js
export async function loadActiveConfig(supabase) {
  // 1) active config version
  const { data: cfg, error: cfgErr } = await supabase
    .from("config_versions")
    .select("id,label")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (cfgErr || !cfg) throw new Error("No active config_versions row found.");

  // 2) load data (active only)
  const [{ data: pricebook, error: pbErr },
         { data: aliases, error: aErr },
         { data: tripFees, error: tfErr },
         { data: rules, error: rErr },
         { data: templates, error: tErr }] = await Promise.all([
    supabase.from("pricebook_items").select("code,name,unit,unit_price,min_qty,notes").eq("active", true),
    supabase.from("aliases").select("alias,code").eq("active", true),
    supabase.from("trip_fees").select("label,base_fee,per_mile,after_hours_fee").eq("active", true),
    supabase.from("estimate_rules").select("rule_key,rule_text,priority").eq("active", true).order("priority", { ascending: true }),
    supabase.from("templates").select("template_key,subject,body_html").eq("active", true),
  ]);

  if (pbErr) throw new Error(`pricebook_items load failed: ${pbErr.message}`);
  if (aErr) throw new Error(`aliases load failed: ${aErr.message}`);
  if (tfErr) throw new Error(`trip_fees load failed: ${tfErr.message}`);
  if (rErr) throw new Error(`estimate_rules load failed: ${rErr.message}`);
  if (tErr) throw new Error(`templates load failed: ${tErr.message}`);

  const pricebookMap = new Map(pricebook.map((p) => [p.code, p]));
  const aliasMap = new Map(aliases.map((a) => [a.alias.toLowerCase(), a.code]));

  return {
    configVersion: cfg,
    pricebook,
    pricebookMap,
    aliases,
    aliasMap,
    tripFees: tripFees || [],
    rules: rules || [],
    templates: templates || [],
  };
}
