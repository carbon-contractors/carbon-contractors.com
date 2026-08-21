-- 017_drop_waitlist.sql
-- Drop the waitlist table (CC-089, ADR-0002 handover step 9).
--
-- The waitlist was the only place the platform held email addresses, so until it
-- was gone the ADR-0002 D2 claim — "the platform does not hold, request, or
-- verify names, emails, phone numbers, documents or location" — was false. The
-- coming-soon capture form, /api/waitlist and /unsubscribe are removed in the
-- same change.
--
-- The 004 anon-read policy and the 010/015 revokes die with the table; no
-- separate cleanup is needed. notification_channels is deliberately untouched —
-- its optional contact address is how a worker learns they were hired
-- (CC-005, CC-073).

DROP TABLE IF EXISTS waitlist;
