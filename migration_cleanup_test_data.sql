-- One-off cleanup: remove duplicate test events created while the scheduler
-- "Schedule" button was silently failing, and the dead-circle test zones
-- they were linked to. Run manually in the Supabase SQL editor.

-- Delete the 6 test events
delete from events where id in (
  '19ec2b8a-ae37-4ef3-ad80-f903ab782c2a', -- Yes
  '2fe7f287-ecb0-4016-922e-bb4c5bf9e771', -- Yes
  '38d9133c-b6f5-456a-84d3-c3ca055189b2', -- Yes
  'd5bde8e0-2de7-482f-b044-38cc39611c71', -- Yes
  '837a6ba2-40ae-4bcf-8a0d-aea1835d742e', -- Arcana AfterParty
  '25b23e22-0787-484b-ae14-23943ea2aa67'  -- Arcana AfterParty
);

-- Delete the 4 dead-circle zones
delete from zones where id in (
  '649bf5e7-f3ec-4c25-95e4-eb36f681f6a8', -- Test
  '53559ec7-78b7-4453-ab3a-f0d47e4117d9', -- The Circle
  '7019332f-be61-4b3e-b9d8-55571c667063', -- Unnamed Zone
  'cd9e3374-0a09-42b1-b76f-f64f7009f5ed'  -- Unnamed Zone
);
