-- Row-level security for the tenant tables the client never treated as protected.
-- Shape follows 20261021140000_row_level_security: a *_tenant policy for the Space
-- the app sets on the connection, and a *_system policy for the explicit bypass.
--
-- `spaces` and `member` belong to an organization rather than one Space, so their
-- tenant policy resolves the organization through space_members (whose own policy
-- reads only app.space_id, so there is no recursion). `attempts` carries no Space of
-- its own: it belongs to the run that took it.

ALTER TABLE "space_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_members_tenant ON "space_members"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY space_members_system ON "space_members"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "spaces" ENABLE ROW LEVEL SECURITY;
CREATE POLICY spaces_tenant ON "spaces"
  USING ("id" = NULLIF(current_setting('app.space_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY spaces_system ON "spaces"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_tenant ON "member"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY members_system ON "member"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "external_effects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_effects_tenant ON "external_effects"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY external_effects_system ON "external_effects"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "capability_installs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY capability_installs_tenant ON "capability_installs"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY capability_installs_system ON "capability_installs"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "cloud_agents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_agents_tenant ON "cloud_agents"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY cloud_agents_system ON "cloud_agents"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "attempts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY attempts_tenant ON "attempts"
  USING (EXISTS (
    SELECT 1 FROM "runs" r
    WHERE r."id" = "attempts"."runId"
      AND r."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY attempts_system ON "attempts"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "space_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_keys_tenant ON "space_keys"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY space_keys_system ON "space_keys"
  USING ((SELECT app_rls_bypass()));

-- The default-Space trigger inserts a membership for an organization the caller may
-- not be scoped to yet (accepting an invite to a different Space). Under enforced RLS
-- that INSERT would be filtered out silently rather than fail, leaving the member
-- without a home Space. The trigger is an integrity rule, so it runs as its owner,
-- like the billing audit and thread-reads triggers already do.
CREATE OR REPLACE FUNCTION ensure_default_space_membership() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  INSERT INTO "space_members" (
    "id", "spaceId", "organizationId", "userId", "role", "createdAt"
  )
  SELECT
    'default-space-member:' || NEW."id",
    space."id",
    NEW."organizationId",
    NEW."userId",
    NEW."role",
    NEW."createdAt"
  FROM "spaces" AS space
  WHERE space."organizationId" = NEW."organizationId"
    AND space."isDefault"
  ON CONFLICT ("spaceId", "userId") DO NOTHING;
  RETURN NEW;
END;
$$;
