/**
 * Shared collection bound for collection egress.
 *
 * One limit covers a single policy decision, a policy scope resolved from
 * configured collections, a source/derived policy lineage, and an explicit
 * `gno_egress_check` scope, so every egress surface accepts the same
 * collection count. Large deployments keep one collection per access
 * boundary (several hundred is normal), and an unscoped request is checked
 * against every configured collection. The bound keeps one decision, its
 * audit projection and its lineage digest linear and small.
 *
 * @module src/core/egress-limits
 */

/** Maximum collections in one egress decision, scope or lineage. */
export const EGRESS_MAX_COLLECTIONS = 1024;
