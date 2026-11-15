-- A proposal is created as `proposed` and nothing else.
--
-- 20261222130000_wallet_proposals_integrity limits UPDATES to the single
-- transition proposed -> cancelled | expired. Its trigger is BEFORE UPDATE, so
-- an INSERT could still name a terminal status directly: the status CHECK
-- permits all three values, and no update would ever have to happen. A row that
-- was born `cancelled` would look like a decision the owner made, with no
-- proposal behind it and no transition to audit.
--
-- This trigger closes that: creation may only produce `proposed`. It runs for
-- every writer, and the application's login owns nothing on this table, so it
-- cannot be dropped from the runtime role.

CREATE FUNCTION wallet_proposals_created_proposed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'proposed' THEN
    RAISE EXCEPTION 'a wallet proposal is created as proposed, not %', NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wallet_proposals_created_proposed BEFORE INSERT ON "wallet_proposals"
  FOR EACH ROW EXECUTE FUNCTION wallet_proposals_created_proposed();
