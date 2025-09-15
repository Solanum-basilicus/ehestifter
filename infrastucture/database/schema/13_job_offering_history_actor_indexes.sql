IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_JobOfferingHistory_Actor_Timestamp'
    AND object_id = OBJECT_ID(N'dbo.JobOfferingHistory')
)
BEGIN
  CREATE INDEX IX_JobOfferingHistory_Actor_Timestamp
    ON dbo.JobOfferingHistory (ActorId, Timestamp)
    INCLUDE (JobOfferingId, Action, Details);
END