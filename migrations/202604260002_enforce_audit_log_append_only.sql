-- Hard-enforce append-only semantics at the DB layer.
CREATE OR REPLACE FUNCTION prevent_audit_log_update_or_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log_events;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log_events;

CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON audit_log_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_update_or_delete();

CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON audit_log_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_update_or_delete();
