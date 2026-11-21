/**
 * Migration: add covering and lookup indexes for vector owners, traces,
 * document listing, and tag counts; drop strictly redundant left-prefix indexes.
 *
 * @module src/store/migrations/037-performance-indexes
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 37,
  name: "performance_indexes",

  up(db: Database): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vector_owners_partition_variant
        ON vector_owners(partition_id, variant_id, mirror_hash, seq, document_id);
      CREATE INDEX IF NOT EXISTS idx_vector_owners_doc_part
        ON vector_owners(document_id, partition_id, seq, mirror_hash, variant_id);
      CREATE INDEX IF NOT EXISTS idx_vector_owners_mirror_seq
        ON vector_owners(mirror_hash, seq);
      CREATE INDEX IF NOT EXISTS idx_retrieval_traces_created
        ON retrieval_traces(created_at_ms DESC, trace_id ASC);
      CREATE INDEX IF NOT EXISTS idx_documents_collection_mtime
        ON documents(collection, source_mtime DESC, id ASC)
        WHERE active = 1;
      DROP INDEX IF EXISTS idx_doc_tags_tag;
      CREATE INDEX IF NOT EXISTS idx_doc_tags_tag_doc
        ON doc_tags(tag, document_id);
      DROP INDEX IF EXISTS idx_chunks_mirror_hash;
      DROP INDEX IF EXISTS idx_doc_links_source_doc;
      DROP INDEX IF EXISTS idx_doc_edges_src_type;
      DROP INDEX IF EXISTS idx_doc_edges_dst_type;
      DROP INDEX IF EXISTS idx_vectors_model;
    `);
  },

  down(db: Database): void {
    db.exec(`
      DROP INDEX IF EXISTS idx_vector_owners_partition_variant;
      DROP INDEX IF EXISTS idx_vector_owners_doc_part;
      DROP INDEX IF EXISTS idx_vector_owners_mirror_seq;
      DROP INDEX IF EXISTS idx_retrieval_traces_created;
      DROP INDEX IF EXISTS idx_documents_collection_mtime;
      DROP INDEX IF EXISTS idx_doc_tags_tag_doc;
      CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON doc_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_chunks_mirror_hash ON content_chunks(mirror_hash);
      CREATE INDEX IF NOT EXISTS idx_doc_links_source_doc ON doc_links(source_doc_id);
      CREATE INDEX IF NOT EXISTS idx_doc_edges_src_type ON doc_edges(src_doc_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_doc_edges_dst_type ON doc_edges(dst_doc_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_vectors_model ON content_vectors(model);
    `);
  },
};
