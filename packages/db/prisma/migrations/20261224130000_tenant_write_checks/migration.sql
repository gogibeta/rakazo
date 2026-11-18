-- Write-side hardening for the organization tables from
-- 20261224120000_tenant_table_row_security. A single FOR ALL policy reuses its
-- USING predicate as the WITH CHECK for INSERT/UPDATE, and the read predicates
-- for `spaces`, `member` and `space_members` are too broad for writes: a tenant
-- could insert or move a row into another organization as long as one branch of
-- the read predicate still matched (a self-inserted `member` row for an
-- arbitrary organization, say, which the default-Space trigger would then turn
-- into a membership of that organization's home Space). These policies keep the
-- read predicates for SELECT and bind every tenant write to the organization of
-- the Space the caller is scoped to; cross-organization writes stay system-only.

-- space_members: a tenant write must stay inside the current Space, with the
-- organization the Space actually belongs to.
DROP POLICY space_members_tenant ON "space_members";
CREATE POLICY space_members_tenant_select ON "space_members" FOR SELECT
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY space_members_tenant_insert ON "space_members" FOR INSERT
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "organizationId" = (
      SELECT s."organizationId" FROM "spaces" s
      WHERE s."id" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY space_members_tenant_update ON "space_members" FOR UPDATE
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "organizationId" = (
      SELECT s."organizationId" FROM "spaces" s
      WHERE s."id" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY space_members_tenant_delete ON "space_members" FOR DELETE
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));

-- spaces: a tenant write must keep the row in the current Space's organization.
DROP POLICY spaces_tenant ON "spaces";
CREATE POLICY spaces_tenant_select ON "spaces" FOR SELECT
  USING ("id" = NULLIF(current_setting('app.space_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY spaces_tenant_insert ON "spaces" FOR INSERT
  WITH CHECK ("organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY spaces_tenant_update ON "spaces" FOR UPDATE
  USING ("id" = NULLIF(current_setting('app.space_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ))
  WITH CHECK ("organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY spaces_tenant_delete ON "spaces" FOR DELETE
  USING ("id" = NULLIF(current_setting('app.space_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));

-- member: a tenant insert is only ever the caller's own row, in the current
-- Space's organization; a tenant update cannot move a row across organizations.
DROP POLICY members_tenant ON "member";
CREATE POLICY members_tenant_select ON "member" FOR SELECT
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY members_tenant_insert ON "member" FOR INSERT
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "organizationId" = (
      SELECT sm."organizationId" FROM "space_members" sm
      WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      LIMIT 1
    ));
CREATE POLICY members_tenant_update ON "member" FOR UPDATE
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ))
  WITH CHECK ("organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));
CREATE POLICY members_tenant_delete ON "member" FOR DELETE
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
      OR "organizationId" = (
    SELECT sm."organizationId" FROM "space_members" sm
    WHERE sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    LIMIT 1
  ));

-- The default-Space trigger: schema-qualify the tables it touches and drop
-- `public` from its search_path, so nothing creatable in `public` can shadow
-- them for the definer.
CREATE OR REPLACE FUNCTION ensure_default_space_membership() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public."space_members" (
    "id", "spaceId", "organizationId", "userId", "role", "createdAt"
  )
  SELECT
    'default-space-member:' || NEW."id",
    space."id",
    NEW."organizationId",
    NEW."userId",
    NEW."role",
    NEW."createdAt"
  FROM public."spaces" AS space
  WHERE space."organizationId" = NEW."organizationId"
    AND space."isDefault"
  ON CONFLICT ("spaceId", "userId") DO NOTHING;
  RETURN NEW;
END;
$$;
