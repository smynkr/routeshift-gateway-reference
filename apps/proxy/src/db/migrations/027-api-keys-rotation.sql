-- 027-api-keys-rotation.sql
-- LAY-339: rotate-with-grace flow for api_keys.
--
-- Today the only "rotate" path is revoke + create, which forces a hard
-- cutover and a customer-facing window where the old key 401s. With these
-- two columns the old key keeps validating until rotation_grace_until,
-- giving callers a window to deploy the new key.
--
-- rotated_to_id    — points at the new key issued by the rotation. NULL
--                    for keys that haven't been rotated. We don't enforce
--                    a unique constraint on it: in theory a rotation
--                    could itself be rotated again before the first grace
--                    window closes, in which case the chain gets longer.
--
-- rotation_grace_until — when the old key stops validating. validateApiKey
--                    treats `rotation_grace_until < now()` as revoked, in
--                    addition to the existing revoked_at + expires_at
--                    checks. NULL means "no rotation in progress" and is
--                    the default for every existing key.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS rotated_to_id text REFERENCES api_keys(id),
  ADD COLUMN IF NOT EXISTS rotation_grace_until timestamptz;
