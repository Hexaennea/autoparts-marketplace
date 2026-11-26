-- Super admins and first-login password change.
--
-- A super admin is an admin who may also manage other admin accounts (create, block, reset
-- password, promote). Ordinary admins run the marketplace but cannot touch admin accounts.
-- Admins that already exist (created from the command line) become super admins, so the owner
-- keeps full control.
--
-- must_change_password: set when someone else chose the password (a new admin, a reset). Until the
-- user picks their own, the admin area refuses them (see authorize() in http.ts).

ALTER TABLE users
    ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT users_super_admin_is_admin CHECK (NOT is_super_admin OR role = 'admin');

UPDATE users SET is_super_admin = true WHERE role = 'admin';
