-- JobOfferings (new shape)
IF NOT EXISTS (
  SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.JobOfferings') AND type = 'U'
)
BEGIN
  CREATE TABLE dbo.JobOfferings (
      Id UNIQUEIDENTIFIER NOT NULL 
          CONSTRAINT PK_JobOfferings PRIMARY KEY DEFAULT NEWID(),

      -- Where we found it
      FoundOn NVARCHAR(100) NOT NULL,                 -- e.g. linkedin, stepstone, arbeitnow

      -- Canonical identity of the posting
      Provider NVARCHAR(100) NOT NULL,                -- e.g. workday, greenhouse, join, corporate-site
      ProviderTenant NVARCHAR(200) NOT NULL 
          CONSTRAINT DF_JobOfferings_ProviderTenant DEFAULT N'',

      ExternalId NVARCHAR(200) NOT NULL,              -- provider-specific id/slug/hash

      -- Links
      Url NVARCHAR(1000) NOT NULL,
      ApplyUrl NVARCHAR(1000) NULL,

      -- Companies
      HiringCompanyName NVARCHAR(300) NOT NULL,
      PostingCompanyName NVARCHAR(300) NULL,

      -- Job metadata (optional to allow link-only creation)
      Title NVARCHAR(300) NULL,
      RemoteType NVARCHAR(50) NOT NULL 
          CONSTRAINT DF_JobOfferings_RemoteType DEFAULT N'Unknown',
      Description NVARCHAR(MAX) NULL,

      -- Timeline
      FirstSeenAt DATETIME2 NOT NULL 
          CONSTRAINT DF_JobOfferings_FirstSeenAt DEFAULT SYSDATETIME(),
      LastSeenAt DATETIME2 NULL,
      RepostCount INT NOT NULL 
          CONSTRAINT DF_JobOfferings_RepostCount DEFAULT 0,

      -- Provenance / moderation
      CreatedByUserId UNIQUEIDENTIFIER NULL,
      CreatedByAgent NVARCHAR(100) NULL,              -- e.g. scraper/stepstone, telegram/12345
      ModerationStatus TINYINT NOT NULL 
          CONSTRAINT DF_JobOfferings_Moderation DEFAULT 0, -- 0 none, 1 incomplete, 2 misleading
      ModerationNote NVARCHAR(1000) NULL,

      -- Maintenance
      CreatedAt DATETIME2 NOT NULL 
          CONSTRAINT DF_JobOfferings_CreatedAt DEFAULT SYSDATETIME(),
      UpdatedAt DATETIME2 NULL,
      IsDeleted BIT NOT NULL 
          CONSTRAINT DF_JobOfferings_IsDeleted DEFAULT 0
  );

  -- Canonical uniqueness, ignore soft-deleted
  CREATE UNIQUE INDEX UX_JobOfferings_ProviderTenantExternalId
    ON dbo.JobOfferings (Provider, ProviderTenant, ExternalId)
    WHERE IsDeleted = 0;

  -- Useful lookups
  CREATE INDEX IX_JobOfferings_HiringCompanyName
    ON dbo.JobOfferings (HiringCompanyName);

  CREATE INDEX IX_JobOfferings_FoundOn_FirstSeen
    ON dbo.JobOfferings (FoundOn, FirstSeenAt DESC);

  CREATE INDEX IX_JobOfferings_LastSeen
    ON dbo.JobOfferings (LastSeenAt DESC);

  -- Optional FK if Users exists
  IF OBJECT_ID('dbo.Users','U') IS NOT NULL
  BEGIN
    ALTER TABLE dbo.JobOfferings
      ADD CONSTRAINT FK_JobOfferings_Users
      FOREIGN KEY (CreatedByUserId) REFERENCES dbo.Users(Id);
  END
END
ELSE
BEGIN
  PRINT 'dbo.JobOfferings already exists. Skipping create.';
END
GO
