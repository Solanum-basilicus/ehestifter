SET XACT_ABORT ON;
BEGIN TRANSACTION;

------------------------------------------------------------
-- CompatibilityScores: bulk projection by user + jobIds,
-- and category='open' join/filter
------------------------------------------------------------
IF OBJECT_ID(N'dbo.CompatibilityScores', N'U') IS NULL
BEGIN
    RAISERROR('dbo.CompatibilityScores does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_CompatibilityScores_UserJob_Incl'
      AND object_id = OBJECT_ID(N'dbo.CompatibilityScores')
)
BEGIN
    CREATE INDEX IX_CompatibilityScores_UserJob_Incl
        ON dbo.CompatibilityScores (UserId, JobOfferingId)
        INCLUDE (Score, CalculatedAt);
END;

-- Optional companion index for job-driven lookups / joins
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_CompatibilityScores_JobUser_Incl'
      AND object_id = OBJECT_ID(N'dbo.CompatibilityScores')
)
BEGIN
    CREATE INDEX IX_CompatibilityScores_JobUser_Incl
        ON dbo.CompatibilityScores (JobOfferingId, UserId)
        INCLUDE (Score, CalculatedAt);
END;



COMMIT TRANSACTION;