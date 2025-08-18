
-- Child table for multiple locations
IF NOT EXISTS (
  SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.JobOfferingLocations') AND type = 'U'
)
BEGIN
  CREATE TABLE dbo.JobOfferingLocations (
      Id BIGINT IDENTITY(1,1) NOT NULL 
          CONSTRAINT PK_JobOfferingLocations PRIMARY KEY,
      JobOfferingId UNIQUEIDENTIFIER NOT NULL,
      CountryName NVARCHAR(100) NOT NULL,            -- e.g. Germany, Spain
      CountryCode CHAR(2) NULL,                      -- ISO 3166-1 alpha-2 if known (upper)
      CityName NVARCHAR(300) NULL,                   -- e.g. Berlin, Madrid
      Region NVARCHAR(100) NULL                      -- optional region/state if needed
  );

  ALTER TABLE dbo.JobOfferingLocations
    ADD CONSTRAINT FK_JobOfferingLocations_JobOfferings
    FOREIGN KEY (JobOfferingId) REFERENCES dbo.JobOfferings(Id) ON DELETE CASCADE;

  -- Prevent duplicates
  CREATE UNIQUE INDEX UX_Locations_NoCity
    ON dbo.JobOfferingLocations (JobOfferingId, CountryName)
    WHERE CityName IS NULL;

  CREATE UNIQUE INDEX UX_Locations_WithCity
    ON dbo.JobOfferingLocations (JobOfferingId, CountryName, CityName)
    WHERE CityName IS NOT NULL;

  -- Filter performance up to ~1M rows on low tier
  CREATE INDEX IX_Locations_CountryCode ON dbo.JobOfferingLocations (CountryCode) INCLUDE (JobOfferingId);
  CREATE INDEX IX_Locations_CountryName ON dbo.JobOfferingLocations (CountryName) INCLUDE (JobOfferingId);
  CREATE INDEX IX_Locations_CityName ON dbo.JobOfferingLocations (CityName, CountryName) INCLUDE (JobOfferingId);
END
ELSE
BEGIN
  PRINT 'dbo.JobOfferingLocations already exists. Skipping create.';
END
GO