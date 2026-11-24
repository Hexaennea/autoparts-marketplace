-- Audit columns on every table: created_at, created_by, updated_at, updated_by.
--
-- A BEFORE INSERT/UPDATE trigger fills them, so no query has to. The acting user comes from the
-- transaction-local setting app.user_id, which http.ts sets for every signed-in write request.
-- Unset (signup, login, janitor, CLI, seed) means a system change and leaves *_by NULL.
-- Statements that set updated_at / updated_by themselves (e.g. the seed backdating rows) win.
-- New tables must add the columns and the trigger themselves; this migration only covers today's.

CREATE FUNCTION current_actor() RETURNS BIGINT LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::BIGINT
$$;

CREATE FUNCTION stamp_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := COALESCE(NEW.created_by, current_actor());
        NEW.updated_by := COALESCE(NEW.updated_by, NEW.created_by);
    ELSE
        IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
            NEW.updated_at := now();
        END IF;
        IF NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by THEN
            NEW.updated_by := current_actor();
        END IF;
    END IF;
    RETURN NEW;
END
$$;

DO $$
DECLARE
    t TEXT;
    had_updated_at BOOLEAN;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = current_schema() AND tablename <> 'schema_migrations'
        ORDER BY tablename
    LOOP
        had_updated_at := EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = t AND column_name = 'updated_at'
        );
        EXECUTE format(
            'ALTER TABLE %I
                ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                ADD COLUMN IF NOT EXISTS updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL',
            t
        );
        -- Existing rows: last change unknown, so start from when they were created.
        IF NOT had_updated_at THEN
            EXECUTE format('UPDATE %I SET updated_at = created_at', t);
        END IF;
        EXECUTE format(
            'CREATE TRIGGER stamp_audit BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_audit()',
            t
        );
    END LOOP;
END
$$;
