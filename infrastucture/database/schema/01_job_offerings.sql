-- Table: JobOfferings
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[JobOfferings]') AND type = 'U'
)
BEGIN
    CREATE TABLE JobOfferings (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

        -- Source data
        Source NVARCHAR(100) NOT NULL,                 -- e.g., "Stepstone", "Indeed"
        ExternalId NVARCHAR(200) NOT NULL,             -- External ID or hash from source
        Url NVARCHAR(1000) NOT NULL,                   -- Canonical URL to the job post
        ApplyUrl NVARCHAR(1000) NULL,                  -- Direct application link (resolved)

        -- Company details
        HiringCompanyName NVARCHAR(300) NOT NULL,      -- Who is actually hiring
        PostingCompanyName NVARCHAR(300) NULL,         -- May be different, e.g. agency

        -- Job metadata
        Title NVARCHAR(300) NOT NULL,
        Country NVARCHAR(100) NOT NULL,                -- e.g., "Germany", "Spain"
        Locality NVARCHAR(300) NULL,                   -- City, region, district
        RemoteType NVARCHAR(50) NULL,                  -- e.g., "remote", "hybrid", "on-site"
        Description TEXT NULL,

        -- Timeline
        PostedDate DATETIME2 NULL,                     -- As seen on job board
        FirstSeenAt DATETIME2 DEFAULT SYSDATETIME(),   -- When we first ingested it
        LastSeenAt DATETIME2 NULL,                     -- Last time scraper encountered this
        RepostCount INT DEFAULT 0,                     -- Increments when same job reappears

        -- Maintenance
        CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
        UpdatedAt DATETIME2 NULL
    );
END


IF NOT EXISTS (
    SELECT 1 
    FROM sys.indexes 
    WHERE name = 'UX_JobOfferings_Source_ExternalId' AND object_id = OBJECT_ID('JobOfferings')
)
BEGIN
    -- Unique constraint to prevent duplicates
    CREATE UNIQUE INDEX UX_JobOfferings_Source_ExternalId 
        ON JobOfferings(Source, ExternalId);
END


