IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_JobOfferingHistory_JobOfferingId_Timestamp'
      AND object_id = OBJECT_ID(N'dbo.JobOfferingHistory')
)
BEGIN
    CREATE INDEX IX_JobOfferingHistory_JobOfferingId_Timestamp
        ON dbo.JobOfferingHistory (JobOfferingId, Timestamp DESC);
END
GO
