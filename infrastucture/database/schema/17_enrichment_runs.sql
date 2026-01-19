-- Table: dbo.EnrichmentRuns

IF NOT EXISTS (
    SELECT 1 FROM sys.objects
    WHERE object_id = OBJECT_ID(N'[dbo].[EnrichmentRuns]') AND type = 'U'
)
BEGIN
    CREATE TABLE dbo.EnrichmentRuns
    (
        RunId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_EnrichmentRuns PRIMARY KEY,

        EnricherType NVARCHAR(128) NOT NULL,     -- e.g. "compatibility.v1"
        SubjectKey   NVARCHAR(256) NOT NULL,     -- "{jobId}:{userId}"

        JobOfferingId UNIQUEIDENTIFIER NOT NULL,
        UserId UNIQUEIDENTIFIER NOT NULL,

        Status NVARCHAR(32) NOT NULL,            -- Pending/Queued/Leased/Succeeded/Failed/Superseded/Expired

        RequestedAt DATETIMEOFFSET(7) NOT NULL,
        QueuedAt    DATETIMEOFFSET(7) NULL,
        LeasedAt    DATETIMEOFFSET(7) NULL,
        LeaseUntil  DATETIMEOFFSET(7) NULL,
        LeaseToken  UNIQUEIDENTIFIER NULL,

        CVVersionId NVARCHAR(64) NULL,           -- sha256 hex from UserPreferences.CVVersionId (nullable for safety)

        InputSnapshotBlobPath NVARCHAR(500) NULL,

        EnrichmentAttributesJson NVARCHAR(MAX) NULL,
        ResultJson              NVARCHAR(MAX) NULL,

        ErrorCode    NVARCHAR(64) NULL,
        ErrorMessage NVARCHAR(1024) NULL,

        CompletedAt DATETIMEOFFSET(7) NULL,
        UpdatedAt   DATETIMEOFFSET(7) NOT NULL,

        RowVer ROWVERSION NOT NULL,

        CONSTRAINT CK_EnrichmentRuns_Status CHECK (
            Status IN ('Pending','Queued','Leased','Succeeded','Failed','Superseded','Expired')
        ),
        CONSTRAINT CK_EnrichmentRuns_Attrs_IsJson CHECK (
            EnrichmentAttributesJson IS NULL OR ISJSON(EnrichmentAttributesJson) = 1
        ),
        CONSTRAINT CK_EnrichmentRuns_Result_IsJson CHECK (
            ResultJson IS NULL OR ISJSON(ResultJson) = 1
        )
    );

    -- FK to JobOfferings
    IF OBJECT_ID('dbo.JobOfferings','U') IS NOT NULL
    BEGIN
        ALTER TABLE dbo.EnrichmentRuns
          ADD CONSTRAINT FK_EnrichmentRuns_JobOfferings
          FOREIGN KEY (JobOfferingId) REFERENCES dbo.JobOfferings(Id);
    END

    -- FK to Users (if exists)
    IF OBJECT_ID('dbo.Users','U') IS NOT NULL
    BEGIN
        ALTER TABLE dbo.EnrichmentRuns
          ADD CONSTRAINT FK_EnrichmentRuns_Users
          FOREIGN KEY (UserId) REFERENCES dbo.Users(Id);
    END

END
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

-- Enforce "only one active run" (Pending/Queued/Leased) per subject+enricher
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_EnrichmentRuns_Active'
      AND object_id = OBJECT_ID(N'[dbo].[EnrichmentRuns]')
)
BEGIN
    CREATE UNIQUE INDEX UX_EnrichmentRuns_Active
    ON dbo.EnrichmentRuns (EnricherType, SubjectKey)
    WHERE Status IN ('Pending','Queued','Leased');
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
