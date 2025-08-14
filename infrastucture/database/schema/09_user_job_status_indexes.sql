-- Unique pair (JobOfferingId, UserId)
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'UX_UserJobStatus_Job_User'
      AND object_id = OBJECT_ID(N'dbo.UserJobStatus')
)
BEGIN
    CREATE UNIQUE INDEX UX_UserJobStatus_Job_User
        ON dbo.UserJobStatus (JobOfferingId, UserId);
END
GO

-- Lookup by User first (handy for future "my pipeline" pages)
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_UserJobStatus_User'
      AND object_id = OBJECT_ID(N'dbo.UserJobStatus')
)
BEGIN
    CREATE INDEX IX_UserJobStatus_User
        ON dbo.UserJobStatus (UserId);
END
GO

-- Optional covering index for your batch read:
-- WHERE UserId = ? AND JobOfferingId IN (...)
-- This keeps it lean but includes columns you return frequently.
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_UserJobStatus_UserJob_Incl'
      AND object_id = OBJECT_ID(N'dbo.UserJobStatus')
)
BEGIN
    CREATE INDEX IX_UserJobStatus_UserJob_Incl
        ON dbo.UserJobStatus (UserId, JobOfferingId)
        INCLUDE (Status, LastUpdated);
END
GO