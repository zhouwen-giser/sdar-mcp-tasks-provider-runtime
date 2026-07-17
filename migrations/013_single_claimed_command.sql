CREATE UNIQUE INDEX task_command_single_claimed_per_task_idx
  ON task_command (task_id)
  WHERE state = 'CLAIMED';

ALTER TABLE task_command
  ADD CONSTRAINT task_command_claim_lease_consistency CHECK (
    (state = 'CLAIMED' AND claim_owner IS NOT NULL AND claim_until IS NOT NULL)
    OR
    (state <> 'CLAIMED' AND claim_owner IS NULL AND claim_until IS NULL)
  );
