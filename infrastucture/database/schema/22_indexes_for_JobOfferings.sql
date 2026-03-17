SET XACT_ABORT ON;
BEGIN TRANSACTION;

------------------------------------------------------------
-- JobOfferings: active-list ordering and "created by me"
------------------------------------------------------------
IF OBJECT_ID(N'dbo.JobOfferings', N'U') IS NULL
BEGIN
    RAISERROR('dbo.JobOfferings does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

-- Helps common list ordering by created date on active jobs
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_JobOfferings_Active_CreatedAt'
      AND object_id = OBJECT_ID(N'dbo.JobOfferings')
)
BEGIN
    CREATE INDEX IX_JobOfferings_Active_CreatedAt
        ON dbo.JobOfferings (CreatedAt DESC, Id)
        INCLUDE (UpdatedAt, CreatedByUserId)
        WHERE IsDeleted = 0;
END;

-- Helps updated sorting / date_kind=updated fallback paths
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_JobOfferings_Active_UpdatedAt'
      AND object_id = OBJECT_ID(N'dbo.JobOfferings')
)
BEGIN
    CREATE INDEX IX_JobOfferings_Active_UpdatedAt
        ON dbo.JobOfferings (UpdatedAt DESC, CreatedAt DESC, Id)
        INCLUDE (CreatedByUserId)
        WHERE IsDeleted = 0;
END;

-- Helps category='my' for jobs created by the user
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_JobOfferings_Active_CreatedByUser_CreatedAt'
      AND object_id = OBJECT_ID(N'dbo.JobOfferings')
)
BEGIN
    CREATE INDEX IX_JobOfferings_Active_CreatedByUser_CreatedAt
        ON dbo.JobOfferings (CreatedByUserId, CreatedAt DESC, Id)
        INCLUDE (UpdatedAt)
        WHERE IsDeleted = 0 AND CreatedByUserId IS NOT NULL;
END;

COMMIT TRANSACTION;