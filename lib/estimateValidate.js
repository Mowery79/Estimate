// lib/estimateValidate.js
export function validateAndCorrectEstimate(estimate, pricebookMap) {
  const errors = [];
  const unmapped = [];

  const lineItems = Array.isArray(estimate?.line_items) ? estimate.line_items : [];
  const fixed = [];

  for (const li of lineItems) {
    const code = (li?.code || "").trim();
    const qty = Number(li?.qty ?? 1);
    const pb = pricebookMap.get(code);

    if (!pb) {
      unmapped.push(li);
      continue;
    }

    const q = Number.isFinite(qty) && qty > 0 ? qty : Number(pb.min_qty || 1);
    const unitPrice = Number(pb.unit_price);
    const total = round2(q * unitPrice);

    fixed.push({
      code: pb.code,
      name: pb.name,
      description: String(li?.description || ""),
      qty: q,
      unit_price: unitPrice,
      total,
    });

    // If model gave different unit_price, we override (and note it)
    if (Number(li?.unit_price) !== unitPrice) {
      errors.push(`Unit price overridden for ${pb.code}: model=${li?.unit_price} pricebook=${unitPrice}`);
    }
  }

  const subtotal = round2(fixed.reduce((s, x) => s + Number(x.total || 0), 0));
  const tax = round2(Number(estimate?.tax || 0)); // keep if you apply later; or compute from rule
  const total = round2(subtotal + tax);

  const corrected = {
    summary: String(estimate?.summary || ""),
    line_items: fixed,
    subtotal,
    tax,
    total,
    assumptions: Array.isArray(estimate?.assumptions) ? estimate.assumptions.map(String) : [],
  };

  return { corrected, errors, unmapped };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
