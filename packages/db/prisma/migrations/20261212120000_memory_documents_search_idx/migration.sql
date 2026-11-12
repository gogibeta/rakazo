-- Sole statement so the index builds outside an implicit transaction, without
-- blocking memory writes. Backs ranked full-text memory search: 'english'
-- stemming over the content plus the path with its separators as spaces, so
-- "notes/q3-report.pdf" tokenises into words and "budgets" finds "budget".
CREATE INDEX CONCURRENTLY "memory_documents_search_idx" ON "memory_documents"
USING GIN (to_tsvector('english', content || ' ' || translate(path, '/._-', '    ')));
