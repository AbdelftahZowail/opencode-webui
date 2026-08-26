import type { ModelRef } from "../api/types";

/**
 * Canonical "provider/model@variant" label. The service persists an unset
 * variant as "default", so the suffix always renders — same convention as
 * the VariantPicker chip ("@default").
 */
export function formatModelRef(model: ModelRef): string {
  const variant =
    model.variant && model.variant !== "default" ? model.variant : "default";
  return `${model.providerID}/${model.id}@${variant}`;
}
