-- Sole statement so the index builds outside an implicit transaction, without
-- blocking chat writes. Same coverage as messages_history_search_steps_idx except
-- tool steps: steps of the history/memory recall tools (labels "Search history",
-- "Read history", "Recall memory") no longer contribute their labels or notes, so
-- recall traffic is recorded as activity but never becomes searchable content.
CREATE INDEX CONCURRENTLY "messages_history_search_no_recall_idx" ON "messages"
USING GIN (to_tsvector('simple', jsonb_path_query_array(blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").result')::text || translate(jsonb_path_query_array(blocks, '$[*] ? (@.kind == "file" || @.kind == "image").name')::text, '._-', '   ') || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "steps").steps[*] ? (@.label != "Search history" && @.label != "Read history" && @.label != "Recall memory").label')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "steps").steps[*] ? (@.label != "Search history" && @.label != "Read history" && @.label != "Recall memory").note')::text));
