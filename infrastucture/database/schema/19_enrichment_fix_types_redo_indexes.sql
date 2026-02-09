DROP INDEX [IX_EnrichmentRuns_Subject_Latest] ON dbo.EnrichmentRuns;
DROP INDEX [IX_EnrichmentRuns_JobUser] ON dbo.EnrichmentRuns;

ALTER TABLE dbo.EnrichmentRuns ALTER COLUMN RequestedAt  datetime2 NULL;
ALTER TABLE dbo.EnrichmentRuns ALTER COLUMN QueuedAt     datetime2 NULL;
ALTER TABLE dbo.EnrichmentRuns ALTER COLUMN LeasedAt     datetime2 NULL;
ALTER TABLE dbo.EnrichmentRuns ALTER COLUMN LeaseUntil   datetime2 NULL;
ALTER TABLE dbo.EnrichmentRuns ALTER COLUMN UpdatedAt    datetime2 NULL; 
ALTER TABLE dbo.EnrichmentRuns ALTER COLUMN CompletedAt  datetime2 NULL; 
GO

-- Index: latest per subject+enricher
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_EnrichmentRuns_Subject_Latest'
      AND object_id = OBJECT_ID(N'[dbo].[EnrichmentRuns]')
)
BEGIN
    CREATE INDEX IX_EnrichmentRuns_Subject_Latest
    ON dbo.EnrichmentRuns (EnricherType, SubjectKey, RequestedAt DESC)
    INCLUDE (RunId, Status, CompletedAt, ErrorCode, ErrorMessage);
END
GO

-- Useful lookup by JobOfferingId/UserId for UI pages
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_EnrichmentRuns_JobUser'
      AND object_id = OBJECT_ID(N'[dbo].[EnrichmentRuns]')
)
BEGIN
    CREATE INDEX IX_EnrichmentRuns_JobUser
    ON dbo.EnrichmentRuns (JobOfferingId, UserId, RequestedAt DESC)
    INCLUDE (RunId, EnricherType, Status, CompletedAt);
END
GO