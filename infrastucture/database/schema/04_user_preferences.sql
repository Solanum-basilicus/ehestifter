-- Table: UserPreferences

IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[UserPreferences]') AND type = 'U'
)
BEGIN
    CREATE TABLE UserPreferences (
        UserId UNIQUEIDENTIFIER PRIMARY KEY FOREIGN KEY REFERENCES Users(Id),

        -- Path to current CV file in blob storage
        CVBlobPath NVARCHAR(500) NOT NULL,

        -- Timestamp of last update
        LastUpdated DATETIME2 DEFAULT SYSDATETIME()
    );
END

-- Table: UserPreferenceFilters

IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[UserPreferenceFilters]') AND type = 'U'
)
BEGIN
    CREATE TABLE UserPreferenceFilters (
        Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        UserId UNIQUEIDENTIFIER FOREIGN KEY REFERENCES Users(Id),

        -- Natural language filter as entered by the user
        FilterText NVARCHAR(MAX) NOT NULL,

        -- Internal representation for LLM or structured logic
        NormalizedJson NVARCHAR(MAX) NULL,

        CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
        LastUsedAt DATETIME2 NULL
    );
END