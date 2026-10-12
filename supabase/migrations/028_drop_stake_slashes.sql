-- 028_drop_stake_slashes.sql
--
-- ADR-0013 D1 / NOR-537 F2: no monetary stake, so nothing can be slashed and
-- the attribution table from 024 has no purpose. The ReputationStake contract
-- was never slashed against (the Sepolia deployment was virgin, totalStaked 0),
-- so the table is expected to be empty. Check before applying:
--
--   SELECT count(*) FROM public.stake_slashes;
--
-- Apply by hand, in order, like every migration here. The Tier 1 backup
-- exporter no longer lists this table, so there is no ordering constraint with
-- the app deploy.

DROP TABLE IF EXISTS public.stake_slashes;
