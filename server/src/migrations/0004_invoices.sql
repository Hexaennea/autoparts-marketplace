-- GST tax invoices.
--
-- On a marketplace the seller is the supplier, so every shipment (fulfilment) gets its own tax
-- invoice in the seller's name. The invoice is issued when the goods leave: the moment shipped_at
-- is first set. A trigger does it, so every path that ships (seller, admin, seed) is covered.
--
-- Invoice numbers are consecutive per seller per financial year (April-March, India time), at most
-- 16 characters as GST rules require: S<seller id>/<FY>/<serial>, e.g. S12/2627/00001.
-- The seller's name, GSTIN and address are copied onto the invoice when it is issued, so a later
-- profile change never alters an invoice already given to a buyer.

CREATE TABLE invoice_series (
    seller_id   BIGINT  NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
    fy          TEXT    NOT NULL,
    last_no     INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT  REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT  REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (seller_id, fy)
);
CREATE TRIGGER stamp_audit BEFORE INSERT OR UPDATE ON invoice_series FOR EACH ROW EXECUTE FUNCTION stamp_audit();

ALTER TABLE fulfilments
    ADD COLUMN invoice_number TEXT UNIQUE,
    ADD COLUMN invoice_date   DATE,
    ADD COLUMN invoice_seller JSONB;

CREATE FUNCTION assign_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    d   DATE;
    y   INTEGER;
    v_fy TEXT;
    n   INTEGER;
BEGIN
    IF NEW.shipped_at IS NULL OR NEW.invoice_number IS NOT NULL THEN
        RETURN NEW;
    END IF;
    d := (NEW.shipped_at AT TIME ZONE 'Asia/Kolkata')::date;
    y := EXTRACT(YEAR FROM d)::INTEGER - CASE WHEN EXTRACT(MONTH FROM d) < 4 THEN 1 ELSE 0 END;
    v_fy := lpad((y % 100)::text, 2, '0') || lpad(((y + 1) % 100)::text, 2, '0');
    -- The upsert locks the series row, so concurrent shipments of one seller get distinct numbers.
    INSERT INTO invoice_series (seller_id, fy, last_no) VALUES (NEW.seller_id, v_fy, 1)
    ON CONFLICT (seller_id, fy) DO UPDATE SET last_no = invoice_series.last_no + 1
    RETURNING last_no INTO n;
    NEW.invoice_number := 'S' || NEW.seller_id || '/' || v_fy || '/' || lpad(n::text, 5, '0');
    NEW.invoice_date := d;
    NEW.invoice_seller := (
        SELECT jsonb_build_object(
            'business_name', s.business_name, 'display_name', s.display_name, 'gstin', s.gstin,
            'address_line', s.address_line, 'city', s.city, 'state', s.state, 'pincode', s.pincode,
            'phone', s.phone)
        FROM sellers s WHERE s.id = NEW.seller_id
    );
    RETURN NEW;
END
$$;

CREATE TRIGGER assign_invoice BEFORE INSERT OR UPDATE OF shipped_at ON fulfilments
    FOR EACH ROW EXECUTE FUNCTION assign_invoice();

-- Shipments that already left get their invoices now, numbered in the order they shipped.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT id FROM fulfilments WHERE shipped_at IS NOT NULL ORDER BY shipped_at, id LOOP
        UPDATE fulfilments SET shipped_at = shipped_at WHERE id = r.id;
    END LOOP;
END $$;

-- Same lockdown as 0003 for the new table (Supabase only).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON invoice_series FROM anon, authenticated;
        REVOKE ALL ON FUNCTION assign_invoice() FROM anon, authenticated;
        ALTER TABLE invoice_series ENABLE ROW LEVEL SECURITY;
    END IF;
END $$;
