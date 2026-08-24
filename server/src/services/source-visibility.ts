// source-visibility.ts — shared SQL visibility predicate (features 001+002).
//
// One row participates in ANY merged listing iff:
//   1. its owner source is enabled (feature 001), and
//   2. if owned by a catalog-kind source with an active curated list, it is
//      curated-in: an explicit include override, or — absent an exclude
//      override — it matches the list's STATIC criteria against
//      model_metadata (evaluated live; feature 002).
//
// Requires the caller's query to expose `m` (models) and `mm`
// (model_metadata LEFT JOINed on mm.model_db_id = m.id).

export function sourceVisibilityExpr(): string {
  return `
    (m.source_ref_id IS NULL OR (
      EXISTS (
        SELECT 1 FROM model_sources ms WHERE ms.id = m.source_ref_id AND ms.enabled = 1
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM model_sources ms2
          WHERE ms2.id = m.source_ref_id AND ms2.kind = 'catalog' AND ms2.active_list_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM curation_overrides ov
          JOIN model_sources ms3 ON ms3.id = m.source_ref_id AND ms3.active_list_id = ov.list_id
          WHERE ov.platform = m.platform AND ov.model_id = m.model_id AND ov.decision = 'include'
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM curation_overrides ov2
            JOIN model_sources ms4 ON ms4.id = m.source_ref_id AND ms4.active_list_id = ov2.list_id
            WHERE ov2.platform = m.platform AND ov2.model_id = m.model_id AND ov2.decision = 'exclude'
          )
          AND EXISTS (
            SELECT 1 FROM model_sources ms5
            JOIN curation_lists cl ON cl.id = ms5.active_list_id
            WHERE ms5.id = m.source_ref_id
              AND (
                (json_extract(cl.criteria, '$.free_only') IS NOT NULL
                  AND json_extract(cl.criteria, '$.free_only') = 1
                  AND COALESCE(mm.cost_input, -1) = 0
                  AND COALESCE(mm.cost_output, -1) = 0)
                AND (json_extract(cl.criteria, '$.min_context') IS NULL
                  OR (mm.context_limit IS NOT NULL
                      AND mm.context_limit >= json_extract(cl.criteria, '$.min_context')))
                AND (json_extract(cl.criteria, '$.max_cost_input') IS NULL
                  OR (mm.cost_input IS NOT NULL
                      AND mm.cost_input <= json_extract(cl.criteria, '$.max_cost_input')))
                AND (json_extract(cl.criteria, '$.tool_call') IS NOT 1 OR mm.tool_call = 1)
                AND (json_extract(cl.criteria, '$.reasoning') IS NOT 1 OR mm.reasoning = 1)
                AND (json_extract(cl.criteria, '$.open_weights') IS NOT 1 OR mm.open_weights = 1)
                AND (json_extract(cl.criteria, '$.input_image') IS NOT 1
                  OR EXISTS (
                    SELECT 1 FROM json_each(mm.modalities_input)
                    WHERE json_each.value = 'image'
                  ))
              )
          )
        )
      )
    ))`;
}
